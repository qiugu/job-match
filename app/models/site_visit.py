"""遗留表：匿名站点访问（按天、访客、路径去重）。

自 2026-11-09（迁移 r3s5t7u9v1w3）起不再写入、也不再参与统计：
该唯一约束只能表达「访客×路径」组合数，无法作为 PV。统计改读
``app.models.site_visit_event.SiteVisitEvent``。此模型与表保留，避免历史
数据失去 ORM 映射；历史行已在迁移中按 1 行 = 1 次浏览回填为新表基线。
"""
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
