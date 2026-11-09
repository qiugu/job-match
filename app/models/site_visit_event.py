"""站点浏览事件（append-only）：一行 = 一次页面浏览，供管理员仪表盘统计。

与遗留表 `site_visits`（按 天+访客+路径 去重）不同，本表刻意不去重：

- PV = count(*)（含刷新、回访同一路径）
- 日 UV = 当日 count(distinct visitor_hash)
- 区间 UV = 整个窗口内 count(distinct visitor_hash)，不能由日 UV 求和得到

occurred_at 一律为 naive UTC（见 app/core/timeutils.py）；展示时按 tz_offset
换算成本地自然日，避免把 UTC 日界当成用户日界。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.timeutils import utcnow


def _id() -> str:
    return uuid.uuid4().hex


class SiteVisitEvent(Base):
    __tablename__ = "site_visit_events"
    __table_args__ = (
        # 覆盖索引：窗口过滤与 count(distinct visitor_hash) 均可走索引，
        # 90 天窗口下无需回表扫描全部事件行。
        Index("ix_site_visit_events_occurred_visitor", "occurred_at", "visitor_hash"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    visitor_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    path: Mapped[str] = mapped_column(String(255), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
