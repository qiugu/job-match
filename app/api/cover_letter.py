"""话术（JD 话术）API：与简历匹配解耦的独立资源。

端点前缀 /api/cover-letters：
  POST   /               生成话术（调 run_cover_letter，落库；生成前预扣共享匹配额度）
  GET    /               话术列表（可按 derived_resume_id 过滤）
  GET    /{id}           话术详情
  PUT    /{id}           更新正文（用户二次编辑，不消耗额度）
  DELETE /{id}           删除话术
  POST   /{id}/regenerate 换措辞重新生成（再次预扣额度）

话术与简历匹配共享 match_quota：每次生成 / 重生成都预扣 1 次，失败归还，
与 create_match 的额度策略一致。关联衍生简历时必须为本人的记录。
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.logging import get_logger
from app.core.prompts import COVER_LETTER_SCENES
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import JOB_STATUS_DEFAULT
from app.models.user import User
from app.schemas.agent import CoverLetterRequest, CoverLetterResult
from app.services.agent import run_cover_letter
from app.services.job import attach_or_create_job, promote_for_action
from app.services.quota import refund_match_quota, reserve_match_quota

logger = get_logger("cover_letter")

# 无限制额度的哨兵值（与 match.py 保持一致）
UNLIMITED_QUOTA = -1

router = APIRouter(prefix="/api/cover-letters", tags=["cover-letters"])


class CoverLetterUpdate(BaseModel):
    """用户二次编辑话术正文（仅保存，不触发 LLM、不消耗额度）。"""

    content: str


class CoverLetterRegenerate(BaseModel):
    """重新生成可选覆盖场景；不传则沿用原 scene。"""

    scene: str | None = None


def _to_result(
    c: CoverLetter, remaining_quota: int | None = None, job_id: str | None = None
) -> CoverLetterResult:
    """ORM 行 → 响应模型（datetime 转 iso 字符串）。

    remaining_quota 仅由「生成 / 重生成」端点填充（消耗共享额度后回查的最新剩余次数），
    其余非消耗型操作传 None，前端据此不刷新配额显示。
    job_id 缺省取 c.job_id（写链路已挂载）；调用方亦可直接覆盖传入。
    """
    return CoverLetterResult(
        id=c.id,
        content=c.content,
        scene=c.scene,
        model=c.model,
        created_at=c.created_at.isoformat(),
        updated_at=c.updated_at.isoformat(),
        remaining_quota=remaining_quota,
        job_id=job_id if job_id is not None else c.job_id,
    )


async def _remaining_quota(db: AsyncSession, user: User) -> int:
    """扣额后回查用户最新剩余匹配次数（绕过 identity map 强制从 DB 重读）。"""
    fresh = await db.get(User, user.id, populate_existing=True)
    if fresh.unlimited_match_quota:
        return UNLIMITED_QUOTA
    return max(int(fresh.match_quota), 0)


def _ensure_owner(c: CoverLetter | None, user: User) -> CoverLetter:
    """校验话术归属当前用户：非本人记录返回 404，不暴露资源是否存在。"""
    if c is None or c.user_id != user.id:
        raise HTTPException(status_code=404, detail="话术不存在")
    return c


async def _generate_text(
    user: User, jd_text: str, resume_text: str, scene: str
) -> str:
    """预扣共享匹配额度后调用 LLM 生成话术；失败归还额度并转 503。

    抽取为内部函数，供「生成」与「重生成」复用同一套额度 + 错误处理。
    """
    # 场景白名单校验：非法 scene 会让 prompt 静默退化为默认场景，
    # 与用户预期不符，因此在扣额度之前直接拒绝。
    if scene not in COVER_LETTER_SCENES:
        raise HTTPException(
            status_code=400,
            detail=f"场景不合法，仅支持：{'/'.join(COVER_LETTER_SCENES)}",
        )

    reserved = False
    if not user.unlimited_match_quota:
        if not await reserve_match_quota(user.id):
            raise HTTPException(
                status_code=403,
                detail="匹配次数已用完，请联系管理员获取新的注册码额度",
            )
        reserved = True
    try:
        return await run_cover_letter(
            jd_text=jd_text, resume_text=resume_text, scene=scene
        )
    except RuntimeError as e:
        # LLM 未配置 / 超时 / 调用失败等可预期错误 → 503
        if reserved:
            await refund_match_quota(user.id)
        logger.warning("话术生成失败（503）: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except Exception:
        # 未预期异常：归还额度后按原样抛出（全局兜底转 500）
        if reserved:
            await refund_match_quota(user.id)
        raise


@router.post("", summary="生成话术（JD 话术匹配）")
async def create_cover_letter(
    req: CoverLetterRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not req.resume_text.strip() or not req.jd_text.strip():
        raise HTTPException(status_code=400, detail="简历文本与岗位描述均不能为空")

    # 归属校验：若关联衍生简历，必须是本人记录（不存在 / 他人记录统一 404）
    if req.derived_resume_id:
        dr = await db.get(DerivedResume, req.derived_resume_id)
        if dr is None or dr.user_id != user.id:
            raise HTTPException(status_code=404, detail="关联的衍生简历不存在")

    # 自动挂载岗位卡：归一化 JD 查重，命中复用旧卡，未命中建新卡；
    # 返回 job.id 写入话术的 job_id（实现「生成即建档、刷新不丢上下文」）。
    # V2：首动作定初始态——新建卡进入 greeting_sent；复用旧卡不在此处改状态。
    job = await attach_or_create_job(
        db, user.id, req.jd_text, initial_status=JOB_STATUS_DEFAULT
    )

    content = await _generate_text(user, req.jd_text, req.resume_text, req.scene)

    cover = CoverLetter(
        user_id=user.id,
        derived_resume_id=req.derived_resume_id,
        job_id=job.id,
        resume_text=req.resume_text,
        jd_text=req.jd_text,
        scene=req.scene,
        content=content,
        model=settings.llm_model,
    )
    db.add(cover)
    # V2：生成话术是「打招呼」动作，只前进不回退地推进岗位阶段；
    # closed 卡上再次生成视为重新激活（有简历则回到 resume_ready）。
    await promote_for_action(db, job, JOB_STATUS_DEFAULT)
    try:
        await db.commit()
        await db.refresh(cover)
    except Exception:
        # 落库失败：这次生成没产出可保存结果，归还预扣额度
        if not user.unlimited_match_quota:
            await refund_match_quota(user.id)
        raise
    # 生成消耗了 1 次共享额度：回查最新剩余次数供前端刷新侧边栏显示
    remaining = await _remaining_quota(db, user)
    return _to_result(cover, remaining_quota=remaining)


@router.get("", summary="话术列表")
async def list_cover_letters(
    derived_resume_id: str | None = None,
    job_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(CoverLetter).where(CoverLetter.user_id == user.id)
    if derived_resume_id:
        stmt = stmt.where(CoverLetter.derived_resume_id == derived_resume_id)
    if job_id:
        stmt = stmt.where(CoverLetter.job_id == job_id)
    stmt = stmt.order_by(CoverLetter.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    return [_to_result(c) for c in rows]


@router.get("/{cover_id}", summary="话术详情")
async def get_cover_letter(
    cover_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cover = await db.get(CoverLetter, cover_id)
    _ensure_owner(cover, user)
    return _to_result(cover)


@router.put("/{cover_id}", summary="更新话术正文（用户二次编辑）")
async def update_cover_letter(
    cover_id: str,
    payload: CoverLetterUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cover = await db.get(CoverLetter, cover_id)
    _ensure_owner(cover, user)
    # 仅保存用户编辑，不触发 LLM、不消耗额度
    cover.content = payload.content
    await db.commit()
    await db.refresh(cover)
    return _to_result(cover)


@router.delete("/{cover_id}", summary="删除话术")
async def delete_cover_letter(
    cover_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cover = await db.get(CoverLetter, cover_id)
    _ensure_owner(cover, user)
    await db.delete(cover)
    await db.commit()
    return {"id": cover.id, "deleted": True}


@router.post("/{cover_id}/regenerate", summary="重新生成话术")
async def regenerate_cover_letter(
    cover_id: str,
    payload: CoverLetterRegenerate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cover = await db.get(CoverLetter, cover_id)
    _ensure_owner(cover, user)
    # 重生成用原快照的 resume_text / jd_text，scene 可被本次请求覆盖
    scene = payload.scene or cover.scene
    content = await _generate_text(user, cover.jd_text, cover.resume_text, scene)
    cover.content = content
    cover.scene = scene
    cover.model = settings.llm_model
    # updated_at 由模型 onupdate 自动刷新
    try:
        await db.commit()
        await db.refresh(cover)
    except Exception:
        if not user.unlimited_match_quota:
            await refund_match_quota(user.id)
        raise
    # 重生成同样消耗 1 次共享额度：回查最新剩余次数供前端刷新
    remaining = await _remaining_quota(db, user)
    return _to_result(cover, remaining_quota=remaining)
