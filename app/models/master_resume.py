"""简历模型：用户上传的 PDF 解析后存储，作为匹配任务的简历来源。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class MasterResume(Base):
    __tablename__ = "master_resumes"
    # 标题即简历的唯一标识：与列表中用户看到的名字一致，重名写入会被数据库拒绝。
    __table_args__ = (UniqueConstraint("title", name="uq_master_resumes_title"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    title: Mapped[str] = mapped_column(String(255), default="我的简历")
    original_filename: Mapped[str] = mapped_column(String(255), default="")
    # 原始 PDF 文本（解析所得）
    raw_text: Mapped[str] = mapped_column(Text, default="")
    # 结构化 ResumeData（JSON 字符串）
    resume_json: Mapped[str] = mapped_column(Text, default="{}")
    # 简历 markdown 预览文本，用于列表卡片缩略图，避免列表接口返回完整 resume_json
    markdown_content: Mapped[str | None] = mapped_column(Text, default=None, nullable=True)
    # 【已废弃】简历正文指纹（sha256）：曾用于按内容去重，会把「新建的简历」静默
    # 错绑到另一条已有记录上，已改为「标题唯一」。仅保留列以便回滚，不再写入/查询，
    # 后续迁移清理。
    content_hash: Mapped[str] = mapped_column(
        String(64), default="", nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
