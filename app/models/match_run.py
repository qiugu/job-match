"""一次简历匹配工作流的持久化运行记录。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class MatchRun(Base):
    __tablename__ = "match_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 匹配开始时岗位卡可能尚未创建，成功落库后再补齐。
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    derived_resume_id: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    match_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    matched_count: Mapped[int] = mapped_column(Integer, default=0)
    weak_count: Mapped[int] = mapped_column(Integer, default=0)
    missing_count: Mapped[int] = mapped_column(Integer, default=0)
    unsupported_count: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    model: Mapped[str] = mapped_column(String(64), default="")
    error_type: Mapped[str] = mapped_column(String(64), default="")
    error_message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
