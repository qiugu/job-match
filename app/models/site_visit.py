"""匿名站点访问事件：按天、访客和路径去重，用于管理员 UV/PV。"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SiteVisit(Base):
    __tablename__ = "site_visits"
    __table_args__ = (
        UniqueConstraint("visit_date", "visitor_hash", "path", name="uq_site_visits_day_visitor_path"),
        Index("ix_site_visits_date", "visit_date"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    visit_date: Mapped[date] = mapped_column(Date, nullable=False)
    visitor_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    path: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
