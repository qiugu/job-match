"""求职信（JD 话术）模型：从简历匹配副产物解耦为独立资源。

可关联也可不关联衍生简历：匹配顺带生成时填 derived_resume_id；
独立生成时 derived_resume_id 为空，仅以 user_id + resume_text + jd_text 溯源。
场景 scene 区分话术用途（greeting 打招呼 / followup 跟进 / interview 邀约面试）。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class CoverLetter(Base):
    __tablename__ = "cover_letters"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 归属用户（与项目其他 user_id 一致：String(32)，可空默认空串表示无归属）
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 关联衍生简历：匹配顺带生成时填充；独立生成时为空（解耦）
    derived_resume_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("derived_resumes.id", ondelete="CASCADE"),
        nullable=True,
    )
    # 归属岗位卡：话术按 JD 自动建档/查重挂载（app/services/job.attach_or_create_job）；
    # 删岗位卡默认置空此列（SET NULL），话术作为用户资产保留（不级联删除）。
    job_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    # 生成时的简历 / JD 快照，便于追溯与独立刷新
    resume_text: Mapped[str] = mapped_column(Text, default="")
    jd_text: Mapped[str] = mapped_column(Text, default="")
    # 场景：greeting / followup / interview 等，默认 greeting
    scene: Mapped[str] = mapped_column(String(32), default="greeting")
    # 话术正文
    content: Mapped[str] = mapped_column(Text, default="")
    # 生成模型（审计用，可空）
    model: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    # 注：原 DerivedResume.cover_letter / CoverLetter.derived relationship 已删除。
    # 关联通过 derived_resume_id 字符串外键实现（按需 db.get(DerivedResume, id) 查询），
    # 不再用 ORM 关系耦合，话术与匹配结果完全解耦为独立资源。
