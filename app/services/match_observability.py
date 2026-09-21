"""简历匹配运行台账的写入与上下文关联。"""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta
from typing import Any, Iterator

from sqlalchemy import func, select

from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.core.timeutils import utcnow
from app.models.llm_usage import LlmUsage
from app.models.match_run import MatchRun
from app.models.match_run_step import MatchRunStep

logger = get_logger("match_observability")

_current_run_id: ContextVar[str | None] = ContextVar(
    "match_observability_run_id", default=None
)


@contextmanager
def match_run_context(run_id: str) -> Iterator[str]:
    token = _current_run_id.set(run_id)
    try:
        yield run_id
    finally:
        _current_run_id.reset(token)


def get_match_run_id() -> str | None:
    return _current_run_id.get()


async def start_match_run(user_id: str) -> str:
    run_id = uuid.uuid4().hex
    try:
        async with AsyncSessionLocal() as db:
            db.add(MatchRun(id=run_id, user_id=user_id, status="running"))
            await db.commit()
    except Exception:  # noqa: BLE001 - 观测旁路不能影响业务
        logger.exception("创建匹配运行台账失败 | user_id=%s", user_id)
    return run_id


async def record_match_step(
    run_id: str,
    *,
    step_key: str,
    status: str,
    latency_ms: int,
    attempt: int = 1,
    error_type: str = "",
) -> None:
    now = utcnow()
    started = now - timedelta(milliseconds=max(0, latency_ms))
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                MatchRunStep(
                    match_run_id=run_id,
                    step_key=step_key,
                    status=status,
                    attempt=attempt,
                    started_at=started,
                    completed_at=now,
                    latency_ms=max(0, latency_ms),
                    error_type=error_type,
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception(
            "写入匹配节点台账失败（不影响业务） | run_id=%s step=%s",
            run_id,
            step_key,
        )


def _quality_counts(analysis: dict[str, Any] | None) -> dict[str, int]:
    counts = {"matched": 0, "weak": 0, "missing": 0, "unsupported": 0}
    for item in (analysis or {}).get("requirements", []):
        strength = str(item.get("strength") or "")
        key = "unsupported" if strength == "unspported" else strength
        if key in counts:
            counts[key] += 1
    return counts


async def finish_match_run(
    run_id: str,
    *,
    status: str,
    job_id: str | None = None,
    derived_resume_id: str | None = None,
    analysis: dict[str, Any] | None = None,
    error: BaseException | None = None,
) -> None:
    completed = utcnow()
    counts = _quality_counts(analysis)
    try:
        async with AsyncSessionLocal() as db:
            run = await db.get(MatchRun, run_id)
            if run is None:
                return
            usage = (
                await db.execute(
                    select(
                        func.coalesce(func.sum(LlmUsage.prompt_tokens), 0),
                        func.coalesce(func.sum(LlmUsage.completion_tokens), 0),
                        func.coalesce(func.sum(LlmUsage.total_tokens), 0),
                        func.max(LlmUsage.model),
                    ).where(LlmUsage.match_run_id == run_id)
                )
            ).one()
            run.status = status
            run.completed_at = completed
            run.latency_ms = max(
                0, int((completed - run.started_at).total_seconds() * 1000)
            )
            if job_id is not None:
                run.job_id = job_id
            if derived_resume_id is not None:
                run.derived_resume_id = derived_resume_id
            if analysis is not None:
                run.match_score = analysis.get("score")
                run.matched_count = counts["matched"]
                run.weak_count = counts["weak"]
                run.missing_count = counts["missing"]
                run.unsupported_count = counts["unsupported"]
            run.prompt_tokens = int(usage[0] or 0)
            run.completion_tokens = int(usage[1] or 0)
            run.total_tokens = int(usage[2] or 0)
            run.model = str(usage[3] or "")
            if error is not None:
                run.error_type = type(error).__name__
                run.error_message = str(error)[:1000]
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("完成匹配运行台账失败 | run_id=%s", run_id)
