"""衍生简历模型：基于一份简历 + JD 经 Agent 匹配优化后生成。

不再与「主简历」绑定溯源：匹配接口直接接收简历文本，本表仅保存匹配结果。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class DerivedResume(Base):
    __tablename__ = "derived_resumes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 归属用户（对应 users.id，空串表示迁移遗留的无归属数据）
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 优化后的简历（markdown 文本）
    markdown_content: Mapped[str] = mapped_column(Text, default="")
    title: Mapped[str] = mapped_column(String(255), default="")
    jd_text: Mapped[str] = mapped_column(Text, default="")
    keywords: Mapped[str] = mapped_column(Text, default="[]")
    has_cover_letter: Mapped[bool] = mapped_column(Boolean, default=False)
    # 用户是否已确认接受该匹配结果（前端「接受」按钮）
    accepted: Mapped[bool] = mapped_column(Boolean, default=False)
    # 匹配分析（MatchResult 结构：role/score/requirements/summary 的 JSON 原文）。
    # V2 起 create_match 落库持久化，供岗位页「回看匹配结果」；历史记录为 NULL。
    analysis_json: Mapped[str | None] = mapped_column(Text, default=None, nullable=True)
    # 归属岗位卡：匹配按 JD 自动建档/查重挂载（app/services/job.attach_or_create_job）；
    # 删岗位卡默认置空此列（SET NULL），匹配作为用户资产保留（不级联删除）。
    # 已接受简历在 master_resumes 的副本是独立资产，不受岗位卡删除影响。
    job_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 接受后落库到 master_resumes 的简历 id（去重置位时返回已有记录），
    # 标记该匹配结果已被采纳为「我的简历」中的一份资产。
    accepted_master_id: Mapped[str | None] = mapped_column(
        String(32), default=None, nullable=True
    )
    # 注：原 cover_letter relationship 已删除（话术解耦为独立资源，通过 derived_resume_id
    # 字符串外键按需 db.get(CoverLetter) 查询，不再用 ORM 关系耦合）。
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
