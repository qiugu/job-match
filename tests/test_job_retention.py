"""投递数据保留策略测试（app/services/job_cleanup.py）。

覆盖：
- 超期 closed 卡被清理：卡删、事件随卡删、子资产 job_id 置空转「未归类」。
- 窗口内 closed 卡、活跃卡（greeting_sent / applied）永不清理。
- job_retention_days=0 时禁用清理（幂等安全阀）。
- run_retention_cleanup 独立会话路径（lifespan 循环的实际入口）。
- 统计区间上限与保留期对齐：clamp_days(365) == 180。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

import app.services.job_cleanup as job_cleanup_module
from app.core.config import settings
from app.models.cover_letter import CoverLetter
from app.models.derived_resume import DerivedResume
from app.models.job import (
    JOB_STATUS_APPLIED,
    JOB_STATUS_CLOSED,
    JOB_STATUS_DEFAULT,
    Job,
)
from app.models.job_event import JobStatusEvent
from app.services.job_cleanup import cleanup_expired_closed_jobs, run_retention_cleanup


def _ago(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


async def _make_job(
    session,
    *,
    status: str,
    updated: datetime,
    user_id: str = "u1",
) -> Job:
    """直插岗位卡并显式写 updated_at（绕过 onupdate，构造超期数据）。"""
    job = Job(
        user_id=user_id,
        jd_text=f"jd-{status}-{updated.isoformat()}",
        status=status,
    )
    session.add(job)
    await session.flush()
    job.updated_at = updated
    await session.flush()
    return job


@pytest.mark.asyncio
async def test_expired_closed_job_cleaned_with_cascade(session, monkeypatch):
    """超期 closed 卡：卡删 + 事件随卡删 + 子资产转未归类。"""
    monkeypatch.setattr(settings, "job_retention_days", 180)
    expired = await _make_job(session, status=JOB_STATUS_CLOSED, updated=_ago(200))
    cl = CoverLetter(user_id="u1", job_id=expired.id, content="hello")
    dr = DerivedResume(user_id="u1", job_id=expired.id, markdown_content="# r")
    ev = JobStatusEvent(
        user_id="u1",
        job_id=expired.id,
        from_status=None,
        to_status=JOB_STATUS_DEFAULT,
        source="create",
        occurred_at=_ago(220),
    )
    session.add_all([cl, dr, ev])
    await session.commit()

    removed = await cleanup_expired_closed_jobs(session)

    assert removed == 1
    assert await session.get(Job, expired.id) is None
    events = (
        (
            await session.execute(
                select(JobStatusEvent).where(JobStatusEvent.job_id == expired.id)
            )
        )
        .scalars()
        .all()
    )
    assert events == []
    # 会话内对象可能持有陈旧值（Core UPDATE 不同步 identity map），
    # 用 populate_existing 重新取数验证真实落库状态
    cl_now = (
        (
            await session.execute(
                select(CoverLetter)
                .where(CoverLetter.id == cl.id)
                .execution_options(populate_existing=True)
            )
        )
        .scalar_one()
    )
    dr_now = (
        (
            await session.execute(
                select(DerivedResume)
                .where(DerivedResume.id == dr.id)
                .execution_options(populate_existing=True)
            )
        )
        .scalar_one()
    )
    assert cl_now.job_id is None
    assert dr_now.job_id is None


@pytest.mark.asyncio
async def test_recent_closed_and_active_jobs_are_kept(session, monkeypatch):
    """窗口内 closed 卡与老活跃卡（applied / greeting_sent）永不清理。"""
    monkeypatch.setattr(settings, "job_retention_days", 180)
    recent_closed = await _make_job(
        session, status=JOB_STATUS_CLOSED, updated=_ago(100)
    )
    old_applied = await _make_job(
        session, status=JOB_STATUS_APPLIED, updated=_ago(400)
    )
    old_active = await _make_job(
        session, status=JOB_STATUS_DEFAULT, updated=_ago(400)
    )
    await session.commit()

    removed = await cleanup_expired_closed_jobs(session)

    assert removed == 0
    for job in (recent_closed, old_applied, old_active):
        assert await session.get(Job, job.id) is not None


@pytest.mark.asyncio
async def test_retention_disabled_is_noop(session, monkeypatch):
    """job_retention_days=0：禁用自动清理，任何数据都不动。"""
    monkeypatch.setattr(settings, "job_retention_days", 0)
    expired = await _make_job(session, status=JOB_STATUS_CLOSED, updated=_ago(400))
    await session.commit()

    removed = await cleanup_expired_closed_jobs(session)

    assert removed == 0
    assert await session.get(Job, expired.id) is not None


@pytest.mark.asyncio
async def test_run_retention_cleanup_uses_own_session(session_factory, monkeypatch):
    """run_retention_cleanup 经独立会话执行（lifespan 循环的真实入口）。"""
    monkeypatch.setattr(job_cleanup_module, "AsyncSessionLocal", session_factory)
    monkeypatch.setattr(settings, "job_retention_days", 180)
    async with session_factory() as db:
        await _make_job(db, status=JOB_STATUS_CLOSED, updated=_ago(200))
        await db.commit()

    removed = await run_retention_cleanup()

    assert removed == 1
    async with session_factory() as db:
        remaining = (await db.execute(select(Job))).scalars().all()
    assert remaining == []


def test_clamp_days_upper_bound_aligned_with_retention():
    """统计区间上限必须随保留期收敛：365 / 999 clamp 到 180。"""
    from app.services.job_stats import ALLOWED_DAYS, clamp_days

    assert 365 not in ALLOWED_DAYS
    assert clamp_days(365) == 180
    assert clamp_days(999) == 180
    assert clamp_days(7) == 7
    assert clamp_days(0) == 7
