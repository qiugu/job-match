"""匹配/衍生简历 API：创建匹配简历（触发 Agent）、列表、详情、更新、求职信。"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.logging import get_logger
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.master_resume import MasterResume
from app.schemas.resume import ResumeData
from app.services.agent import run_match

logger = get_logger("match")

router = APIRouter(prefix="/api/derived-resumes", tags=["derived-resumes"])


async def _master_title_taken(db: AsyncSession, title: str) -> bool:
    """标题是否已被占用（master_resumes 以标题为唯一键）。"""
    return (
        await db.execute(
            select(MasterResume.id).where(MasterResume.title == title).limit(1)
        )
    ).first() is not None


async def _unique_master_title(db: AsyncSession, title: str) -> str:
    """为落库的匹配结果生成不冲突的标题。

    接受匹配是后端内部流程，不应因重名报错或覆盖用户已有的简历，
    因此冲突时追加序号后缀（`xxx (2)`）。
    """
    if not await _master_title_taken(db, title):
        return title
    for i in range(2, 100):
        candidate = f"{title} ({i})"
        if not await _master_title_taken(db, candidate):
            return candidate
    return f"{title} ({uuid.uuid4().hex[:6]})"


class MatchRequest(BaseModel):
    # 匹配基准简历文本（用户从已上传简历中选择的 markdown 文本，直接传入）
    resumeText: str
    jdText: str
    withCoverLetter: bool = False
    title: str = ""


@router.post("", summary="创建匹配简历（触发 Agent 优化）")
async def create_match(req: MatchRequest, db: AsyncSession = Depends(get_db)):
    if not req.resumeText.strip():
        raise HTTPException(status_code=400, detail="简历文本不能为空")
    try:
        keywords, resume_md, cover, refactor_mode, analysis = await run_match(
            master_text=req.resumeText,
            jd_text=req.jdText,
            with_cover_letter=req.withCoverLetter,
        )
    except RuntimeError as e:
        # LLM 未配置、超时、LLM 调用失败等可预期错误，返回 503 而非 500
        # 完整 traceback 已在 agent.run_match 内记录，此处仅记录简要原因便于检索
        logger.warning("创建匹配失败（503）: %s", e)
        raise HTTPException(status_code=503, detail=str(e))

    did = uuid.uuid4().hex
    now = _now_iso()
    # 匹配方式（rewrite/optimize）由 LLM 自行判断，记录其输出
    matched_mode = refactor_mode or "rewrite"
    # 标题冲突时自动追加「自动1/自动2…」，确保 JD 生成的简历名称唯一
    title = await _unique_derived_title(db, req.title or f"匹配简历-{matched_mode}")

    # 匹配结果即 markdown 简历文本（非结构化 JSON 模块化简历）
    derived = DerivedResume(
        id=did,
        title=title,
        jd_text=req.jdText,
        match_mode=matched_mode,
        markdown_content=resume_md,
        keywords=json.dumps(keywords),
        has_cover_letter=bool(cover),
    )
    db.add(derived)
    if cover:
        db.add(CoverLetter(id=uuid.uuid4().hex, derived_resume_id=did, content=cover))
    await db.commit()
    await db.refresh(derived)

    return {
        "id": derived.id,
        "title": derived.title,
        "matchMode": derived.match_mode,
        "keywords": keywords,
        "markdownContent": resume_md,
        "coverLetter": cover,
        "hasCoverLetter": bool(cover),
        "matchAnalysis": analysis,
        "accepted": bool(derived.accepted),
        "createdAt": derived.created_at.isoformat(),
    }


@router.get("", summary="衍生简历列表")
async def list_derived(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(DerivedResume).order_by(DerivedResume.created_at.desc()))).scalars().all()
    return [
        {
            "id": r.id,
            "title": r.title,
            "matchMode": r.match_mode,
            "hasCoverLetter": r.has_cover_letter,
            "createdAt": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/{derived_id}", summary="衍生简历详情")
async def get_derived(derived_id: str, db: AsyncSession = Depends(get_db)):
    r = (
        await db.execute(
            select(DerivedResume)
            .options(selectinload(DerivedResume.cover_letter))
            .where(DerivedResume.id == derived_id)
        )
    ).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="衍生简历不存在")
    cover = r.cover_letter.content if r.cover_letter else None
    return {
        "id": r.id,
        "title": r.title,
        "matchMode": r.match_mode,
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
    derived_id: str, payload: DerivedResumePatch, db: AsyncSession = Depends(get_db)
):
    r = await db.get(DerivedResume, derived_id)
    if not r:
        raise HTTPException(status_code=404, detail="衍生简历不存在")
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
    derived_id: str, payload: AcceptPayload, db: AsyncSession = Depends(get_db)
):
    r = await db.get(DerivedResume, derived_id)
    if not r:
        raise HTTPException(status_code=404, detail="衍生简历不存在")

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
        if existing is not None:
            accepted_master_id = existing.id
            deduped = True
        else:
            title = await _unique_master_title(db, r.title or "匹配结果简历")
            master = MasterResume(
                title=title,
                raw_text="",
                markdown_content=r.markdown_content,
            )
            data = ResumeData(
                title=title,
                markdownContent=r.markdown_content,
            )
            master.resume_json = data.model_dump_json()
            db.add(master)
            await db.flush()
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
async def get_cover_letter(derived_id: str, db: AsyncSession = Depends(get_db)):
    r = (
        await db.execute(
            select(DerivedResume)
            .options(selectinload(DerivedResume.cover_letter))
            .where(DerivedResume.id == derived_id)
        )
    ).scalar_one_or_none()
    if not r or not r.cover_letter:
        raise HTTPException(status_code=404, detail="求职信不存在")
    return {"content": r.cover_letter.content}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _unique_derived_title(db: AsyncSession, base: str) -> str:
    """为 JD 自动生成的匹配简历生成唯一标题。

    若 base 已被占用，自动追加「自动1 / 自动2 …」后缀，直到不冲突。
    这样同一份源简历反复匹配时不会被唯一性约束拦截。
    """
    title = base
    n = 1
    while (await db.execute(select(DerivedResume).where(DerivedResume.title == title).limit(1))).scalars().first():
        title = f"{base}自动{n}"
        n += 1
    return title
