"""岗位卡自动挂载的并发与模型约束回归测试。"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import UniqueConstraint, select

from app.models.derived_resume import DerivedResume
from app.models.job import Job
from app.models.job_event import JobStatusEvent
from app.services.job import attach_or_create_job


def test_job_model_declares_user_jd_uniqueness() -> None:
    constraints = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in Job.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }

    assert constraints["uq_jobs_user_id_jd_text"] == ("user_id", "jd_text")


@pytest.mark.asyncio
async def test_concurrent_attach_reuses_one_job_and_preserves_children(
    session_factory,
) -> None:
    """第二个写者撞唯一键后应复用首个岗位卡，且两个子记录都能提交。"""
    user_id = "concurrent-user"
    jd_text = "  Python 后端工程师\n负责 API 平台  "

    async with session_factory() as first, session_factory() as second:
        first_job = await attach_or_create_job(first, user_id, jd_text)
        first.add(
            DerivedResume(
                id="derived-first",
                user_id=user_id,
                job_id=first_job.id,
                title="first",
                jd_text=jd_text,
                markdown_content="# first",
            )
        )
        # 子记录已进入数据库事务但尚未提交：第二个写者撞键恢复时，首个写者的
        # 子记录和 create 事件都必须保持完整。先 flush 也避免 SQLite 在首个事务
        # 仍需追加写入时与等待唯一键的第二个写者形成锁升级争用。
        await first.flush()

        # 新实现会在 attach 内 flush，并让第二个写者等待首个事务结束；旧实现
        # 则会立即返回第二个尚未 flush 的 Job。两种路径都由同一测试稳定覆盖。
        second_attach = asyncio.create_task(
            attach_or_create_job(second, user_id, jd_text)
        )
        await asyncio.sleep(0.05)
        await first.commit()

        second_job = await asyncio.wait_for(second_attach, timeout=5)
        second.add(
            DerivedResume(
                id="derived-second",
                user_id=user_id,
                job_id=second_job.id,
                title="second",
                jd_text=jd_text,
                markdown_content="# second",
            )
        )
        await second.commit()

    async with session_factory() as verify:
        jobs = (
            await verify.execute(select(Job).where(Job.user_id == user_id))
        ).scalars().all()
        children = (
            await verify.execute(
                select(DerivedResume).where(DerivedResume.user_id == user_id)
            )
        ).scalars().all()
        events = (
            await verify.execute(
                select(JobStatusEvent).where(JobStatusEvent.user_id == user_id)
            )
        ).scalars().all()

    assert len(jobs) == 1
    assert first_job.id == second_job.id == jobs[0].id
    assert {child.job_id for child in children} == {jobs[0].id}
    assert {child.id for child in children} == {"derived-first", "derived-second"}
    assert [(event.job_id, event.source) for event in events] == [
        (jobs[0].id, "create")
    ]
