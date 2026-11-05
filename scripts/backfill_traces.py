"""一次性回填：把存量观测数据迁移到统一 traces/spans 模型。

运行方式（仓库根目录）：
    .venv/bin/python scripts/backfill_traces.py

幂等性：以「源主键是否已存在对应 trace」为判断，重复执行不会产生重复行。

回填映射（docs/PLAN_unified_observability.md §四）：

1. ``match_runs`` → ``traces``（endpoint=match，job_id → context_id）；
2. ``match_run_steps`` → ``spans``（match_run_id → trace_id，字段直映）；
3. ``llm_usage`` 中 endpoint != 'match' 且 match_run_id 为空的记录 → 各生成一条
   trace（endpoint 直映）+ 一条 span（step_key 取端点短名）。

回填后 ``match_runs`` / ``match_run_steps`` 保留不删、停止写入；``llm_usage``
继续作为成本台账。旧查询路径（match_stats / ai_stats）由 P4 统一 API 替代后下线。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.models.llm_usage import LlmUsage
from app.models.match_run import MatchRun
from app.models.match_run_step import MatchRunStep
from app.models.span import Span
from app.models.trace import Trace

# 端点短名 → 单步 span 的 step_key（翻译等单步端点）
_ENDPOINT_STEP_KEY = {
    "ai.translate": "translate",
    "ai.polish": "polish",
    "ai.grammar": "grammar",
    "ai.resume_import": "resume_import",
    "cover_letter": "cover_letter",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex


async def _backfill_match_runs() -> None:
    async with AsyncSessionLocal() as db:
        runs = (await db.execute(select(MatchRun))).scalars().all()
        for run in runs:
            # 幂等：trace_id 复用 match_run_id，已存在则跳过
            if await db.get(Trace, run.id):
                continue
            db.add(
                Trace(
                    id=run.id,
                    user_id=run.user_id,
                    endpoint="match",
                    status=run.status,
                    started_at=run.started_at or _now(),
                    completed_at=run.completed_at,
                    latency_ms=run.latency_ms,
                    model=run.model,
                    prompt_version="",
                    error_type=run.error_type,
                    error_message=run.error_message,
                    context_id=run.job_id,
                    detail="",
                    created_at=run.created_at or _now(),
                )
            )
        await db.commit()
        print(f"回填 match_runs → traces：{len(runs)} 条")


async def _backfill_match_steps() -> None:
    async with AsyncSessionLocal() as db:
        steps = (await db.execute(select(MatchRunStep))).scalars().all()
        for step in steps:
            if await db.get(Span, step.id):
                continue
            db.add(
                Span(
                    id=step.id,
                    trace_id=step.match_run_id,
                    parent_span_id=None,
                    step_key=step.step_key,
                    status=step.status,
                    attempt=step.attempt,
                    started_at=step.started_at or _now(),
                    completed_at=step.completed_at,
                    latency_ms=step.latency_ms,
                    prompt_tokens=step.prompt_tokens,
                    completion_tokens=step.completion_tokens,
                    total_tokens=step.total_tokens,
                    model=step.model,
                    error_type=step.error_type,
                )
            )
        await db.commit()
        print(f"回填 match_run_steps → spans：{len(steps)} 条")


async def _backfill_llm_usage_singles() -> None:
    """非 match 端点、且无 match_run_id 归属的 llm_usage → trace + 单 span。"""
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(LlmUsage).where(
                    LlmUsage.endpoint != "match",
                    (LlmUsage.match_run_id.is_(None)) | (LlmUsage.match_run_id == ""),
                )
            )
        ).scalars().all()
        count = 0
        for row in rows:
            trace_id = _new_id()
            step_key = _ENDPOINT_STEP_KEY.get(row.endpoint, row.endpoint or "unknown")
            # llm_usage.id 唯一，用它做幂等键：生成本次回填的 trace 时，把
            # trace 的 context_id 记为 llm_usage.id 的固定前缀，便于二次运行跳过。
            # 更简单可靠的做法：用一个独立的幂等标记——这里用「detail 前缀」不可行，
            # 因此改为：检查是否已存在「由本次回填生成」的 span（step_key 含端点、
            # 且 created 时间在本次运行内）。为稳妥，直接以 llm_usage.id 作为 span_id。
            span_id = row.id
            if await db.get(Span, span_id):
                continue
            db.add(
                Trace(
                    id=trace_id,
                    user_id=row.user_id,
                    endpoint=row.endpoint,
                    status=row.status,
                    started_at=row.created_at or _now(),
                    completed_at=row.created_at,
                    latency_ms=row.latency_ms,
                    model=row.model,
                    prompt_version=row.prompt_version,
                    error_type=row.error_type,
                    error_message="",
                    context_id=None,
                    detail=row.detail,
                    created_at=row.created_at or _now(),
                )
            )
            db.add(
                Span(
                    id=span_id,
                    trace_id=trace_id,
                    parent_span_id=None,
                    step_key=step_key,
                    status=row.status,
                    attempt=1,
                    started_at=row.created_at or _now(),
                    completed_at=row.created_at,
                    latency_ms=row.latency_ms,
                    prompt_tokens=row.prompt_tokens,
                    completion_tokens=row.completion_tokens,
                    total_tokens=row.total_tokens,
                    model=row.model,
                    error_type=row.error_type,
                )
            )
            count += 1
        await db.commit()
        print(f"回填 llm_usage(非 match) → trace+span：{count} 条")


async def main() -> None:
    await _backfill_match_runs()
    await _backfill_match_steps()
    await _backfill_llm_usage_singles()


if __name__ == "__main__":
    asyncio.run(main())
