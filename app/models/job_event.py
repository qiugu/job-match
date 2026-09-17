"""岗位卡状态事件台账（append-only）：唯一记录「状态何时变化」的不可变事实。

为什么需要这张表：
    `jobs` 表只有 `created_at` / `updated_at`，而 `updated_at` 带 `onupdate=_now`——
    改标题、改公司、任何一次状态推进都会刷新它。因此「某天投递了几家」这个事实
    无法从 `jobs` 单独还原：用户 PATCH 一次公司名，历史图表就会整体漂移。

    本表把每次状态变更（from → to）连同发生时刻固化为一条只插不改的记录，
    使投递日、漏斗转化、投递周期成为可精确计算（新数据）或可明确标注（回填数据）的量。
    设计与既有 `llm_usage` 台账表同构：不持有业务正文，只承载事实与时间。

写入纪律：
    全项目只有 `app/services/job.py::record_status_event` 一个写入点，
    且只经由 `transition()` 调用——保证「状态变了必有事件」，杜绝漏记。

生命周期：
    事件随所属岗位卡一同删除（`app/api/jobs.py` 的两种删除模式都会清理），
    因此统计口径恒等于「当前存在的岗位卡的行为」，与岗位列表页数字一致。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# ---- 事件来源（source）----
# 区分「运行时真实记录」与「迁移回填的近似值」：统计接口据此标记近似数据点，
# 前端对回填日以斜纹底纹区分，不把推测当事实呈现。
EVENT_SOURCE_CREATE = "create"  # 建卡（from_status 恒为 NULL）
EVENT_SOURCE_AUTO = "auto"  # 内容操作自动推进（生成话术 / 生成定制简历）
EVENT_SOURCE_MANUAL = "manual"  # 用户手动确认（mark applied / closed）
EVENT_SOURCE_REOPEN = "reopen"  # 已结束卡重新开启
EVENT_SOURCE_BACKFILL = "backfill"  # 迁移回填：存量卡的一次性近似重建

JOB_EVENT_SOURCES: tuple[str, ...] = (
    EVENT_SOURCE_CREATE,
    EVENT_SOURCE_AUTO,
    EVENT_SOURCE_MANUAL,
    EVENT_SOURCE_REOPEN,
    EVENT_SOURCE_BACKFILL,
)


def _now() -> datetime:
    """统一 UTC（naive）时间基准，与全库其他表一致。"""
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class JobStatusEvent(Base):
    """一条状态变更事实。只插入、不更新（append-only）。"""

    __tablename__ = "job_status_events"
    __table_args__ = (
        # 统计主查询路径：某用户某时间窗内的事件。user_id 为最左前缀，
        # 因此不再单独建 user_id 单列索引（复合索引已可服务按用户过滤）。
        Index(
            "ix_job_status_events_user_occurred",
            "user_id",
            "occurred_at",
        ),
        # 删除岗位卡时按 job_id 清理事件；亦供单卡事件回看。
        Index("ix_job_status_events_job_id", "job_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 归属用户（与项目其他 user_id 一致：String(32)，空串表示无归属的迁移遗留数据）
    user_id: Mapped[str] = mapped_column(String(32), default="")
    # 归属岗位卡。不建 FK 约束：与 llm_usage 一致，避免 SQLite 下插入顺序耦合；
    # 一致性由服务层（删除时显式清理）保证。
    job_id: Mapped[str] = mapped_column(String(32), default="")
    # 变更前状态；建卡事件为 NULL（无前驱）
    from_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 变更后状态，取值见 app/models/job.py::JOB_STATUSES
    to_status: Mapped[str] = mapped_column(String(32), default="")
    # 事件来源，取值见 JOB_EVENT_SOURCES
    source: Mapped[str] = mapped_column(
        String(16), default=EVENT_SOURCE_AUTO
    )
    # 事实发生时刻（UTC naive）。这是统计的唯一时间基准，永不被后续写入覆盖。
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
