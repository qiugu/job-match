"""简历 API：上传 PDF、列表、详情、删除。

唯一性约定：简历以「标题」为唯一标识（与列表中用户看到的名字一致）。
上传/保存时若标题已存在返回 409，由用户改名后重试——不做静默复用或覆盖，
避免用户上传的文件名与列表里显示的名字对不上。

历史遗留：master_resumes.content_hash（正文指纹）曾用于按内容去重，已废弃，
不再写入也不再参与查询；仅保留列以便回滚，后续迁移再清理。
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.logging import get_logger
from app.models.master_resume import MasterResume
from app.models.user import User
from app.schemas.resume import ResumeData
from app.services.pdf_parser import extract_pdf_text, extract_markdown_structure

logger = get_logger("resume")

router = APIRouter(prefix="/api/master-resumes", tags=["master-resumes"])


def _html_to_text(html: str) -> str:
    """将简单 HTML（如 skillContent）转为纯文本行。"""
    if not html:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return text


def _resume_data_to_markdown(payload: ResumeData) -> str:
    """从结构化 ResumeData 推导 Markdown 文本，作为匹配基准与列表预览兜底。"""
    lines: list[str] = []

    name = (payload.basic.name or "").strip()
    title = (payload.title or payload.basic.title or "").strip()
    if name or title:
        lines.append("# " + " | ".join([p for p in [name, title] if p]))

    contacts = [
        (payload.basic.phone or "").strip(),
        (payload.basic.email or "").strip(),
        (payload.basic.location or "").strip(),
        (payload.basic.employementStatus or "").strip(),
    ]
    contacts = [c for c in contacts if c]
    if contacts:
        lines.append(" · ".join(contacts))

    skills_text = _html_to_text(payload.skillContent or "")
    if skills_text:
        lines.append("")
        lines.append("## 专业技能")
        for line in skills_text.splitlines():
            line = line.strip()
            if line:
                lines.append(f"- {line}")

    if payload.experience:
        lines.append("")
        lines.append("## 工作经历")
        for item in payload.experience:
            if item.visible is False:
                continue
            head = " · ".join([p for p in [item.position, item.company] if p])
            date = (item.date or "").strip()
            if head:
                lines.append(f"### {head}{f'（{date}）' if date else ''}")
            elif date:
                lines.append(f"### {date}")
            details = _html_to_text(item.details or "")
            for d in details.splitlines():
                d = d.strip()
                if d:
                    lines.append(f"- {d}")

    if payload.projects:
        lines.append("")
        lines.append("## 项目经历")
        for item in payload.projects:
            if item.visible is False:
                continue
            head = " · ".join([p for p in [item.name, item.role] if p])
            date = (item.date or "").strip()
            if head:
                lines.append(f"### {head}{f'（{date}）' if date else ''}")
            elif date:
                lines.append(f"### {date}")
            description = _html_to_text(item.description or "")
            for d in description.splitlines():
                d = d.strip()
                if d:
                    lines.append(f"- {d}")

    if payload.education:
        lines.append("")
        lines.append("## 教育经历")
        for item in payload.education:
            school = (item.school or "").strip()
            major = (item.major or "").strip()
            degree = (item.degree or "").strip()
            date = " - ".join([d for d in [item.startDate, item.endDate] if d])
            major_degree = " ".join([d for d in [major, degree] if d])
            head = " · ".join([p for p in [school, major_degree] if p])
            if head:
                lines.append(f"### {head}{f'（{date}）' if date else ''}")
            elif date:
                lines.append(f"### {date}")
            description = _html_to_text(item.description or "")
            for d in description.splitlines():
                d = d.strip()
                if d:
                    lines.append(f"- {d}")

    text = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resume_text(r: MasterResume) -> str:
    """简历正文：优先 PDF 原文，缺失时回退 markdown，再缺失时从结构化 resume_json 推导。"""
    text = (r.raw_text or "").strip() or (r.markdown_content or "").strip()
    if text:
        return text
    if not r.resume_json:
        return ""
    try:
        data = ResumeData.model_validate(json.loads(r.resume_json))
        return _resume_data_to_markdown(data)
    except Exception:
        return ""


def _summary(r: MasterResume) -> dict[str, Any]:
    """列表/上传响应：正文统一取 rawText（markdown 兜底），并标注来源。"""
    return {
        "id": r.id,
        "title": r.title,
        "rawText": _resume_text(r),
        "markdownContent": r.markdown_content,
        "source": "pdf" if (r.raw_text or "").strip() else "editor",
        "createdAt": r.created_at.isoformat(),
        "updatedAt": r.updated_at.isoformat(),
    }


def _ensure_owner(r: MasterResume | None, user: User) -> MasterResume:
    """校验记录归属当前用户：非本人记录返回 404，不暴露资源是否存在。"""
    if r is None or r.user_id != user.id:
        raise HTTPException(status_code=404, detail="简历不存在")
    return r


async def _is_master_title_taken(
    db: AsyncSession, title: str, user_id: str, exclude_id: str | None = None
) -> bool:
    """判断「当前用户」是否已存在同名标题（排除指定 id）。

    标题唯一性的作用域是用户内：多用户共存后全局唯一会让 A 的命名撞上 B 的简历。
    """
    if not title:
        return False
    stmt = select(MasterResume).where(
        MasterResume.title == title, MasterResume.user_id == user_id
    )
    if exclude_id is not None:
        stmt = stmt.where(MasterResume.id != exclude_id)
    return (await db.execute(stmt.limit(1))).scalars().first() is not None


async def _commit_or_409(db: AsyncSession, detail: str) -> None:
    """提交新建记录：并发下的重名由数据库唯一索引兜底，映射为 409 而非 500。

    先查后写存在竞态（两个请求同时通过查重），唯一约束是最终防线。
    """
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=detail) from None


@router.post("", summary="上传简历 PDF")
async def upload_master_resume(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 格式的简历")
    # 标题（文件名）是简历的唯一标识：重名先报错让用户改名，
    # 不静默复用/覆盖已有记录，避免「上传的名字」与「列表里的名字」对不上。
    if await _is_master_title_taken(db, file.filename, user.id):
        raise HTTPException(
            status_code=409,
            detail=f"简历名称「{file.filename}」已存在，请重命名文件后重新上传",
        )
    data = await file.read()
    text = await extract_pdf_text(data)
    if not text.strip():
        raise HTTPException(status_code=422, detail="无法从 PDF 提取文本内容")

    # 确定性（无 LLM）重建原简历的层级 Markdown 骨架，作为匹配时
    # 「结构不动、只改内容」的锚点；提取失败时退回纯文本，避免阻断上传。
    try:
        markdown_structure = extract_markdown_structure(data)
    except Exception as e:  # noqa: BLE001
        logger.warning("PDF 层级结构提取失败（已回退纯文本）: %s", e)
        markdown_structure = text.strip()

    rid = uuid.uuid4().hex
    # 简历先以原始文本存储；结构化 JSON 由前端 pdfjs 解析后随请求更新，或留空由编辑补全
    master = MasterResume(
        id=rid,
        user_id=user.id,
        title=file.filename,
        original_filename=file.filename,
        raw_text=text,
        markdown_content=markdown_structure,
        resume_json=json.dumps(
            ResumeData(id=rid, title=file.filename, createdAt=_now_iso(), updatedAt=_now_iso()).model_dump()
        ),
    )
    db.add(master)
    await _commit_or_409(
        db, f"简历名称「{file.filename}」已存在，请重命名文件后重新上传"
    )
    await db.refresh(master)
    return _summary(master)


@router.post("/json", summary="以结构化 JSON 创建简历（标题必须唯一）")
async def create_master_resume_json(
    payload: ResumeData,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """前端以结构化 ResumeData（含 markdown 简历）创建简历，无需 PDF。

    标题即唯一键：重名返回 409 由用户改名，不复用/覆盖已有记录。
    （曾按正文指纹复用同内容记录，会把新建的简历错绑到另一条已有记录上，已废弃。）
    """
    title = payload.title or "我的简历"
    if await _is_master_title_taken(db, title, user.id):
        raise HTTPException(
            status_code=409,
            detail=f"简历名称「{title}」已存在，请使用其他名称",
        )
    # 未提供 markdown 时从结构化数据自动推导，保证列表与匹配都有可用正文
    markdown_content = payload.markdownContent or _resume_data_to_markdown(payload)
    rid = uuid.uuid4().hex
    # 强制把真实记录 id 写回结构化数据，避免前端传入的临时 uuid 残留在
    # resume_json.id 中（否则前端按该 uuid 删除/更新会 404）。
    stored_payload = payload.model_dump()
    stored_payload["id"] = rid
    master = MasterResume(
        id=rid,
        user_id=user.id,
        title=title,
        original_filename=title,
        raw_text="",
        resume_json=json.dumps(stored_payload),
        markdown_content=markdown_content,
    )
    db.add(master)
    await _commit_or_409(db, f"简历名称「{title}」已存在，请使用其他名称")
    await db.refresh(master)
    return {
        "id": master.id,
        "title": master.title,
        "createdAt": master.created_at.isoformat(),
        "updatedAt": master.updated_at.isoformat(),
    }


@router.get("", summary="简历列表（标题唯一，空记录不返回）")
async def list_master_resumes(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (
        (
            await db.execute(
                select(MasterResume)
                .where(MasterResume.user_id == user.id)
                .order_by(MasterResume.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    result: list[dict] = []
    for r in rows:
        if not _resume_text(r):
            # 既无 PDF 原文也无 markdown 的空记录，无法作为匹配基准
            continue
        result.append(_summary(r))
    return result


@router.get("/{master_id}", summary="简历详情")
async def get_master_resume(
    master_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = _ensure_owner(await db.get(MasterResume, master_id), user)
    resume_json = json.loads(r.resume_json)
    # 回填 markdownContent，保证列表/详情返回与存储一致
    resume_json["markdownContent"] = r.markdown_content
    return {
        "id": r.id,
        "title": r.title,
        "rawText": r.raw_text,
        "resumeJson": resume_json,
        "createdAt": r.created_at.isoformat(),
        "updatedAt": r.updated_at.isoformat(),
    }


@router.put("/{master_id}", summary="更新简历结构化数据")
async def update_master_resume(
    master_id: str,
    payload: ResumeData,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = _ensure_owner(await db.get(MasterResume, master_id), user)
    # 标题改为其他已存在记录的名称：拒绝，避免重名
    if payload.title and payload.title != r.title and await _is_master_title_taken(
        db, payload.title, user.id, exclude_id=master_id
    ):
        raise HTTPException(
            status_code=409,
            detail=f"简历名称「{payload.title}」已存在，请使用其他名称",
        )
    # 强制把真实记录 id 写回结构化数据，避免前端临时 uuid 残留在 resume_json.id
    stored_payload = payload.model_dump()
    stored_payload["id"] = r.id
    r.resume_json = json.dumps(stored_payload)
    r.title = payload.title or r.title
    # 未提供 markdown 时从结构化数据自动推导，避免空记录被列表过滤
    r.markdown_content = payload.markdownContent or _resume_data_to_markdown(payload)
    r.raw_text = r.raw_text or ""
    r.updated_at = datetime.now(timezone.utc)
    await _commit_or_409(
        db, f"简历名称「{payload.title or r.title}」已存在，请使用其他名称"
    )
    return {"id": r.id, "title": r.title, "updatedAt": r.updated_at.isoformat()}


@router.delete("/{master_id}", summary="删除简历")
async def delete_master_resume(
    master_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    r = _ensure_owner(await db.get(MasterResume, master_id), user)
    await db.delete(r)
    await db.commit()
    return {"id": master_id, "deleted": True}


@router.put("/{resume_id}/set_master")
async def set_master_resume(
    resume_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # 兼容旧前端：主简历概念已废弃，该接口保留空操作
    _ensure_owner(await db.get(MasterResume, resume_id), user)
    return {"is_master": False}
