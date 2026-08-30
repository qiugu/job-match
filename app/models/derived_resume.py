"""衍生简历模型：基于一份简历 + JD 经 Agent 匹配优化后生成。

不再与「主简历」绑定溯源：匹配接口直接接收简历文本，本表仅保存匹配结果。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Text, DateTime, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cover_letter import CoverLetter
from sqlalchemy.orm import relationship


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
    # 匹配方式（rewrite/optimize）由 AI 判断后记录
    match_mode: Mapped[str] = mapped_column(String(32), default="rewrite")
    keywords: Mapped[str] = mapped_column(Text, default="[]")
    has_cover_letter: Mapped[bool] = mapped_column(Boolean, default=False)
    # 用户是否已确认接受该匹配结果（前端「接受」按钮）
    accepted: Mapped[bool] = mapped_column(Boolean, default=False)
    # 接受后落库到 master_resumes 的简历 id（去重置位时返回已有记录），
    # 标记该匹配结果已被采纳为「我的简历」中的一份资产。
    accepted_master_id: Mapped[str | None] = mapped_column(
        String(32), default=None, nullable=True
    )
    cover_letter: Mapped["CoverLetter | None"] = relationship(
        "CoverLetter", back_populates="derived", uselist=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
