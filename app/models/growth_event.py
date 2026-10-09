"""隐私安全的增长事件台账。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class GrowthEvent(Base):
    __tablename__ = "growth_events"
    __table_args__ = (
        UniqueConstraint("event_id", name="uq_growth_events_event_id"),
        Index("ix_growth_events_name_occurred", "event_name", "occurred_at"),
        Index("ix_growth_events_user_occurred", "user_id", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    event_id: Mapped[str] = mapped_column(String(64), nullable=False)
    event_name: Mapped[str] = mapped_column(String(48), nullable=False)
    visitor_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    path: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    referrer: Mapped[str] = mapped_column(String(512), default="", nullable=False)
    utm_source: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    utm_medium: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    utm_campaign: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
