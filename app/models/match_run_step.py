"""简历匹配 Agent 节点的持久化执行记录。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class MatchRunStep(Base):
    __tablename__ = "match_run_steps"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    match_run_id: Mapped[str] = mapped_column(String(32), index=True)
    step_key: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(16), default="running")
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    model: Mapped[str] = mapped_column(String(64), default="")
    error_type: Mapped[str] = mapped_column(String(64), default="")
