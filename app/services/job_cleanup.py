"""投递数据保留策略：清理超过保留期的已归档岗位卡。

设计约束（与 docs/ANALYTICS.md、app/services/job_stats.py 口径联动）：

- 只清理 ``status=closed`` 且 ``updated_at`` 早于保留窗口（``JOB_RETENTION_DAYS``，
  默认 180 天）的卡；活跃卡（greeting_sent / resume_ready / applied）永不清理。
- 子资产（cover_letters / derived_resumes）``job_id`` 置空转「未归类」，与手动
  「整理」（``purge=False``）语义一致——话术与匹配结果是用户资产，不随卡删除。
- ``job_status_events`` 随卡删除，与 ``DELETE /api/jobs/{id}`` 的口径一致：
  统计恒等于「当前存在的岗位卡的行为」，避免「列表没有、统计却有」的认知冲突。
  因此统计区间白名单（``ALLOWED_DAYS``）的最大值必须 ≤ 保留期，否则长区间
  图表会对已清理的日期缺数。
- 由 ``main.py`` lifespan 在启动时与每 24 小时各执行一次；执行使用独立会话
  并分批提交（每批 ``BATCH_SIZE`` 张卡），避免单事务过长锁住 SQLite。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import Job, JOB_STATUS_CLOSED
from app.models.job_event import JobStatusEvent

logger = get_logger("job_cleanup")

# 单批处理的卡数上限：控制单条 DELETE ... IN 的长度与事务持锁时间
BATCH_SIZE = 500


async def cleanup_expired_closed_jobs(db) -> int:
    """清理保留期外的已归档岗位卡，返回本次清理的卡数。

    幂等：重复执行时过期集合为空集，直接返回 0。每批独立提交，
    中途失败时已提交批次生效、剩余批次下次继续（保留策略本身允许渐进清理）。
    """
    retention_days = settings.job_retention_days
    if retention_days <= 0:
        return 0
    # 与 usage.py 等既有查询一致：直接用 aware UTC 与库内 _now()（aware）同构比较
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

    total = 0
    while True:
        ids = (
            (
                await db.execute(
                    select(Job.id)
                    .where(Job.status == JOB_STATUS_CLOSED, Job.updated_at < cutoff)
                    .limit(BATCH_SIZE)
                )
            )
            .scalars()
            .all()
        )
        if not ids:
            break
        # 子资产转「未归类」：与手动整理（purge=False）完全同语义
        await db.execute(
            update(CoverLetter)
            .where(CoverLetter.job_id.in_(ids))
            .values(job_id=None)
        )
        await db.execute(
            update(DerivedResume)
            .where(DerivedResume.job_id.in_(ids))
            .values(job_id=None)
        )
        # 状态事件随卡删除（统计口径 = 当前存在岗位卡的行为）
        await db.execute(delete(JobStatusEvent).where(JobStatusEvent.job_id.in_(ids)))
        await db.execute(delete(Job).where(Job.id.in_(ids)))
        await db.commit()
        total += len(ids)
        logger.info("保留策略：本批清理过期归档卡 %d 张", len(ids))
    return total


async def run_retention_cleanup() -> int:
    """独立会话入口：供 lifespan 后台循环调用，返回清理卡数。"""
    async with AsyncSessionLocal() as db:
        return await cleanup_expired_closed_jobs(db)
