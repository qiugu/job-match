"""匹配/衍生简历 API：创建匹配简历（触发 Agent）、列表、详情、更新、求职信。"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.logging import get_logger
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.master_resume import MasterResume
from app.models.user import UNLIMITED_QUOTA, User
from app.schemas.resume import ResumeData
from app.services.agent import MatchPermanentError, MatchTimeoutError, run_match
from app.services.quota import refund_match_quota, reserve_match_quota

logger = get_logger("match")

router = APIRouter(prefix="/api/derived-resumes", tags=["derived-resumes"])


async def _master_title_taken(db: AsyncSession, title: str, user_id: str) -> bool:
    """标题是否被当前用户占用（master_resumes 的标题唯一性作用域是用户内）。"""
    return (
        await db.execute(
            select(MasterResume.id)
            .where(MasterResume.title == title, MasterResume.user_id == user_id)
            .limit(1)
        )
    ).first() is not None


async def _unique_master_title(db: AsyncSession, title: str, user_id: str) -> str:
    """为落库的匹配结果生成不冲突的标题。

    接受匹配是后端内部流程，不应因重名报错或覆盖用户已有的简历，
    因此冲突时追加序号后缀（`xxx (2)`）。
    """
    if not await _master_title_taken(db, title, user_id):
        return title
    for i in range(2, 100):
        candidate = f"{title} ({i})"
        if not await _master_title_taken(db, candidate, user_id):
            return candidate
    return f"{title} ({uuid.uuid4().hex[:6]})"


def _ensure_owner(r: DerivedResume | None, user: User) -> DerivedResume:
    """校验匹配结果归属当前用户：非本人记录返回 404，不暴露资源是否存在。"""
    if r is None or r.user_id != user.id:
        raise HTTPException(status_code=404, detail="衍生简历不存在")
    return r


class MatchRequest(BaseModel):
    # 匹配基准简历文本（用户从已上传简历中选择的 markdown 文本，直接传入）
    resumeText: str
    jdText: str
    withCoverLetter: bool = False
    title: str = ""


@router.post("", summary="创建匹配简历（触发 Agent 优化）")
async def create_match(
    req: MatchRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not req.resumeText.strip():
        raise HTTPException(status_code=400, detail="简历文本不能为空")

    # 匹配会消耗 LLM 额度：调用前原子预扣，失败则归还。
    # 管理员与无限制账号（match_quota < 0）不参与扣减。
    reserved = False
    if not user.unlimited_match_quota:
        if not await reserve_match_quota(user.id):
            raise HTTPException(
                status_code=403,
                detail="匹配次数已用完，请联系管理员获取新的注册码额度",
            )
        reserved = True

    try:
        keywords, resume_md, cover, analysis = await run_match(
            master_text=req.resumeText,
            jd_text=req.jdText,
            with_cover_letter=req.withCoverLetter,
        )
    except MatchTimeoutError as e:
        # 可重试类错误（超时 / 5xx / 429 / 连接）在耗尽重试次数后仍未成功：
        # 返回 503 + 「请稍后重试」文案。本次匹配未产生结果，退回预扣额度，
        # 即超时重试不消耗匹配次数（用户视角仍只算一次尝试）。
        if reserved:
            await refund_match_quota(user.id)
        logger.warning("创建匹配失败（503 超时，已重试仍失败）: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except MatchPermanentError as e:
        # 不可重试类错误（4xx：鉴权 / 余额 / 内容策略 / 入参 / 结构解析）：
        # 立即停止响应、不再重试，退回额度并透传明确错误文案。
        if reserved:
            await refund_match_quota(user.id)
        logger.warning("创建匹配失败（503 不可重试）: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except RuntimeError as e:
        # 其它可预期业务错误（如 LLM 未配置），返回 503 而非 500。
        # 完整 traceback 已在 agent.run_match 内记录，此处仅记录简要原因便于检索
        if reserved:
            await refund_match_quota(user.id)
        logger.warning("创建匹配失败（503）: %s", e)
        raise HTTPException(status_code=503, detail=str(e))
    except Exception:
        if reserved:
            await refund_match_quota(user.id)
        raise

    did = uuid.uuid4().hex
    now = _now_iso()
    # 标题冲突时自动追加「自动1/自动2…」，确保 JD 生成的简历名称唯一
    title = await _unique_derived_title(
        db, req.title or "匹配简历", user.id
    )

    # 匹配结果即 markdown 简历文本（非结构化 JSON 模块化简历）
    derived = DerivedResume(
        id=did,
        user_id=user.id,
        title=title,
        jd_text=req.jdText,
        markdown_content=resume_md,
        keywords=json.dumps(keywords),
        has_cover_letter=bool(cover),
    )
    try:
        db.add(derived)
        if cover:
            db.add(
                CoverLetter(id=uuid.uuid4().hex, derived_resume_id=did, content=cover)
            )
        await db.commit()
        await db.refresh(derived)
    except Exception:
        # 落库失败：这次匹配没产出可用结果，归还预扣额度
        if reserved:
            await refund_match_quota(user.id)
        raise

    return {
        "id": derived.id,
        "title": derived.title,
        "keywords": keywords,
        "markdownContent": resume_md,
        "coverLetter": cover,
        "hasCoverLetter": bool(cover),
        "matchAnalysis": analysis,
        "accepted": bool(derived.accepted),
        "createdAt": derived.created_at.isoformat(),
        # 本次匹配后剩余的次数：-1 表示无限制
        "remainingQuota": (
            UNLIMITED_QUOTA
            if user.unlimited_match_quota
            else max(int(user.match_quota) - 1, 0)
        ),
    }


@router.get("", summary="衍生简历列表")
async def list_derived(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (
        (
            await db.execute(
                select(DerivedResume)
                .where(DerivedResume.user_id == user.id)
                .order_by(DerivedResume.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": r.id,
            "title": r.title,
            "hasCoverLetter": r.has_cover_letter,
            "createdAt": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/{derived_id}", summary="衍生简历详情")
async def get_derived(
    derived_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = (
        await db.execute(
            select(DerivedResume)
            .options(selectinload(DerivedResume.cover_letter))
            .where(DerivedResume.id == derived_id)
        )
    ).scalar_one_or_none()
    r = _ensure_owner(r, user)
    cover = r.cover_letter.content if r.cover_letter else None
    return {
        "id": r.id,
        "title": r.title,
        "jdText": r.jd_text,
        "keywords": json.loads(r.keywords),
        "markdownContent": r.markdown_content,
        "coverLetter": cover,
        "matchAnalysis": None,  # 匹配分析为实时计算结果，未持久化，仅在 create_match 时返回
        "accepted": bool(r.accepted),
        "createdAt": r.created_at.isoformat(),
    }


class DerivedResumePatch(BaseModel):
    """前端二次编辑后回写：衍生简历即 markdown 文本，直接覆盖。"""
    markdownContent: str | None = None
    title: str | None = None


@router.put("/{derived_id}", summary="更新衍生简历（前端二次编辑后回写）")
async def update_derived(
    derived_id: str,
    payload: DerivedResumePatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = _ensure_owner(await db.get(DerivedResume, derived_id), user)
    if payload.markdownContent is not None:
        r.markdown_content = payload.markdownContent
    if payload.title is not None:
        r.title = payload.title
    r.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"id": r.id, "updatedAt": r.updated_at.isoformat()}


class AcceptPayload(BaseModel):
    """确认接受匹配结果。"""

    accepted: bool = True


@router.post("/{derived_id}/accept", summary="确认接受匹配结果并落库为我的简历")
async def accept_match(
    derived_id: str,
    payload: AcceptPayload,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = _ensure_owner(await db.get(DerivedResume, derived_id), user)

    accepted_master_id: str | None = r.accepted_master_id
    deduped = False

    if payload.accepted:
        # 接受 = 把匹配结果落库为「我的简历」中的一份资产。
        # 与编辑器保存通道一致：仅存 markdown 骨架 + 最小占位 ResumeData。
        # 幂等键是上一次落库的记录 id：同一条匹配结果重复接受时直接复用，
        # 与标题/内容都无关（内容每次由 LLM 生成，本就不稳定）。
        existing = (
            await db.get(MasterResume, r.accepted_master_id)
            if r.accepted_master_id
            else None
        )
        # 归属校验：接受记录被他人持有（数据异常/越权）时视为不存在，重新落库
        if existing is not None and existing.user_id != user.id:
            existing = None
        if existing is not None:
            accepted_master_id = existing.id
            deduped = True
        else:
            title = await _unique_master_title(
                db, os.path.splitext(r.title or "匹配结果简历")[0], user.id
            )
            master = MasterResume(
                title=title,
                user_id=user.id,
                raw_text="",
                markdown_content=r.markdown_content,
            )
            db.add(master)
            await db.flush()
            # id 必须在 flush 后才能拿到；resume_json 内的 id 须与记录 id 一致，
            # 否则前端保存时会以空 id 发起 PUT /api/master-resumes/ -> 405。
            data = ResumeData(
                id=master.id,
                title=title,
                markdownContent=r.markdown_content,
            )
            master.resume_json = data.model_dump_json()
            accepted_master_id = master.id

    r.accepted = payload.accepted
    r.accepted_master_id = accepted_master_id
    r.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(r)
    return {
        "id": r.id,
        "accepted": r.accepted,
        "masterResumeId": r.accepted_master_id,
        "deduped": deduped,
        "updatedAt": r.updated_at.isoformat(),
    }


@router.get("/{derived_id}/cover-letter", summary="获取求职信")
async def get_cover_letter(
    derived_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = (
        await db.execute(
            select(DerivedResume)
            .options(selectinload(DerivedResume.cover_letter))
            .where(DerivedResume.id == derived_id)
        )
    ).scalar_one_or_none()
    r = _ensure_owner(r, user)
    if not r.cover_letter:
        raise HTTPException(status_code=404, detail="求职信不存在")
    return {"content": r.cover_letter.content}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _unique_derived_title(db: AsyncSession, base: str, user_id: str) -> str:
    """为 JD 自动生成的匹配简历生成唯一标题。

    若 base 已被占用，自动追加「自动1 / 自动2 …」后缀，直到不冲突。
    这样同一份源简历反复匹配时不会被唯一性约束拦截。
    """
    title = base
    n = 1
    while (
        await db.execute(
            select(DerivedResume)
            .where(DerivedResume.title == title, DerivedResume.user_id == user_id)
            .limit(1)
        )
    ).scalars().first():
        title = f"{base}自动{n}"
        n += 1
    return title
