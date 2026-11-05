"""统一可观测性聚合：从 traces/spans 计算成功率、节点执行状态、耗时分布与成本。

对齐 OpenTelemetry Metrics 语义（只借概念）：Traces/Spans 是原始数据，本模块
把它们聚合为「成功率 + 节点执行状态（P50/P95/重试/错误归因）+ 成本用量」三类信号。

设计原则：

1. **单一事实源**：只读 traces/spans，不读 llm_usage / match_runs（这些是成本
   台账与旧表，回填后由本模型承载执行链观测）。
2. **口径对齐既有**：窗口（clamp_days/clamp_tz_offset）、比率（_rate）、分位
   （_p95）与 match_stats 完全一致，避免同一页相邻面板口径漂移。
3. **节点聚合走 SQL**：跨用户（管理员）视图下节点/端点聚合用 SQL group by，
   不把整表读进内存；明细（最近调用、错误分布）各有上限。
4. **隐私红线**：只返回字段路径/计数/枚举，绝不返回正文（detail 由各端点保证
   只存路径与计数）。
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.span import Span
from app.models.trace import Trace
from app.services.job_stats import clamp_days, clamp_tz_offset


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def _p50(values: list[int]) -> int | None:
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(len(values) * 0.50) - 1)]


def _p95(values: list[int]) -> int | None:
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(len(values) * 0.95) - 1)]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _window(
    days: int, tz_offset: int
) -> tuple[int, int, date, date, datetime, datetime]:
    """时间窗，与 match_stats._window 同口径（本地自然日分桶）。"""
    days = clamp_days(days)
    tz_offset = clamp_tz_offset(tz_offset)
    offset = timedelta(minutes=tz_offset)
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    end_date = (now_utc + offset).date()
    start_date = end_date - timedelta(days=days - 1)
    start_utc = datetime.combine(start_date, time.min) - offset
    end_utc = datetime.combine(end_date + timedelta(days=1), time.min) - offset
    return days, tz_offset, start_date, end_date, start_utc, end_utc


def _parse_detail(text: str) -> dict:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _trace_summary(row: Trace) -> dict[str, Any]:
    return {
        "id": row.id,
        "endpoint": row.endpoint,
        "user_id": row.user_id,
        "status": row.status,
        "error_type": row.error_type or None,
        "model": row.model,
        "latency_ms": row.latency_ms,
        "prompt_version": row.prompt_version or None,
        "context_id": row.context_id,
        "started_at": _iso(row.started_at),
        "completed_at": _iso(row.completed_at),
        "detail_available": bool(row.detail),
        "detail": _parse_detail(row.detail) or None,
    }


async def compute_observability(
    db: AsyncSession,
    user_id: str | None = None,
    days: int = 30,
    tz_offset: int = 480,
    endpoint: str | None = None,
) -> dict[str, Any]:
    """统一可观测性聚合（user_id=None 表示管理员跨用户视角）。

    返回结构（docs/PLAN_unified_observability.md §五）：
      range / overview / nodes / endpoints / cost / daily / recent_traces
    """
    days, tz_offset, start_date, end_date, start_utc, end_utc = _window(
        days, tz_offset
    )

    conditions = [
        Trace.started_at >= start_utc,
        Trace.started_at < end_utc,
    ]
    if user_id is not None:
        conditions.append(Trace.user_id == user_id)
    if endpoint:
        conditions.append(Trace.endpoint == endpoint)

    traces = (
        await db.execute(
            select(Trace).where(*conditions).order_by(Trace.started_at.asc())
        )
    ).scalars().all()

    trace_ids = [t.id for t in traces]
    spans: list[Span] = []
    if trace_ids:
        spans = (
            await db.execute(
                select(Span).where(Span.trace_id.in_(trace_ids))
            )
        ).scalars().all()

    # ---- overview ----
    successes = sum(t.status == "success" for t in traces)
    errors = sum(t.status == "error" for t in traces)
    running = sum(t.status == "running" for t in traces)
    latencies = [t.latency_ms for t in traces if t.status != "running"]
    overview = {
        "total": len(traces),
        "success": successes,
        "error": errors,
        "running": running,
        "success_rate": _rate(successes, len(traces)),
        "avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
        "p95_latency_ms": _p95(latencies),
        "total_tokens": sum(
            s.total_tokens for s in spans
        ),
        "span_count": len(spans),
    }

    # ---- nodes（中间节点执行状态，核心新增）----
    node_map: dict[str, dict[str, Any]] = {}
    for span in spans:
        item = node_map.setdefault(
            span.step_key,
            {
                "step_key": span.step_key,
                "calls": 0,
                "success": 0,
                "error": 0,
                "attempts_total": 0,
                "latencies": [],
                "error_types": {},
                "total_tokens": 0,
            },
        )
        item["calls"] += 1
        item["success"] += 1 if span.status == "success" else 0
        item["error"] += 1 if span.status == "error" else 0
        item["attempts_total"] += span.attempt
        item["latencies"].append(span.latency_ms)
        item["total_tokens"] += span.total_tokens
        if span.error_type:
            item["error_types"][span.error_type] = (
                item["error_types"].get(span.error_type, 0) + 1
            )
    nodes = []
    for item in node_map.values():
        latencies = item.pop("latencies")
        calls = item["calls"]
        error_types = item.pop("error_types")
        nodes.append(
            {
                **item,
                "success_rate": _rate(item["success"], calls),
                "avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
                "p50_latency_ms": _p50(latencies),
                "p95_latency_ms": _p95(latencies),
                "avg_attempt": round(item["attempts_total"] / calls, 2) if calls else None,
                "error_types": sorted(
                    ([k, v] for k, v in error_types.items()),
                    key=lambda kv: kv[1],
                    reverse=True,
                ),
            }
        )
    nodes.sort(key=lambda n: n["step_key"])

    # ---- endpoints（能力维度分布）----
    # token 在 span 层，按 trace 的 endpoint 归因（先建 trace_id → endpoint 映射）。
    trace_endpoint = {t.id: (t.endpoint or "unknown") for t in traces}
    endpoint_map: dict[str, dict[str, Any]] = {}
    for trace in traces:
        item = endpoint_map.setdefault(
            trace.endpoint or "unknown",
            {"endpoint": trace.endpoint or "unknown", "calls": 0, "success": 0, "error": 0, "total_tokens": 0, "latencies": []},
        )
        item["calls"] += 1
        item["success"] += 1 if trace.status == "success" else 0
        item["error"] += 1 if trace.status == "error" else 0
        item["latencies"].append(trace.latency_ms)
    for span in spans:
        ep = trace_endpoint.get(span.trace_id)
        if ep and ep in endpoint_map:
            endpoint_map[ep]["total_tokens"] += span.total_tokens
    endpoints = []
    for item in endpoint_map.values():
        latencies = item.pop("latencies")
        calls = item["calls"]
        endpoints.append(
            {
                **item,
                "success_rate": _rate(item["success"], calls),
                "avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
            }
        )
    endpoints.sort(key=lambda e: e["calls"], reverse=True)

    # ---- cost（成本与用量归因）----
    cost = {
        "total_tokens": sum(s.total_tokens for s in spans),
        "prompt_tokens": sum(s.prompt_tokens for s in spans),
        "completion_tokens": sum(s.completion_tokens for s in spans),
        "by_node": [
            {"step_key": n["step_key"], "total_tokens": n["total_tokens"]}
            for n in nodes
            if n["total_tokens"] > 0
        ],
    }

    # ---- daily ----
    daily: dict[date, dict[str, Any]] = {
        start_date + timedelta(days=i): {
            "date": (start_date + timedelta(days=i)).isoformat(),
            "total": 0,
            "success": 0,
            "error": 0,
            "total_tokens": 0,
        }
        for i in range(days)
    }
    span_tokens_by_trace: dict[str, int] = {}
    for span in spans:
        span_tokens_by_trace[span.trace_id] = (
            span_tokens_by_trace.get(span.trace_id, 0) + span.total_tokens
        )
    for trace in traces:
        local_day = (trace.started_at + timedelta(minutes=tz_offset)).date()
        point = daily.get(local_day)
        if point is None:
            continue
        point["total"] += 1
        point["success" if trace.status == "success" else "error"] += 1
        point["total_tokens"] += span_tokens_by_trace.get(trace.id, 0)

    # ---- recent traces ----
    recent = sorted(traces, key=lambda t: t.started_at, reverse=True)[:20]

    return {
        "range": {
            "days": days,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "tz_offset": tz_offset,
        },
        "scope": "global" if user_id is None else "self",
        "overview": overview,
        "nodes": nodes,
        "endpoints": endpoints,
        "cost": cost,
        "daily": list(daily.values()),
        "recent_traces": [_trace_summary(t) for t in recent],
    }


async def get_trace_detail(
    db: AsyncSession, user_id: str, trace_id: str
) -> dict[str, Any] | None:
    """单次 trace 详情：span 时间线（节点状态/耗时/重试/错误/token）。

    user_id 校验归属，他人记录返回 None（对外 404，不泄露存在性）。
    """
    trace = (
        await db.execute(
            select(Trace).where(Trace.id == trace_id, Trace.user_id == user_id)
        )
    ).scalars().first()
    if trace is None:
        return None
    spans = (
        await db.execute(
            select(Span)
            .where(Span.trace_id == trace.id)
            .order_by(Span.started_at.asc(), Span.attempt.asc())
        )
    ).scalars().all()
    return {
        "trace": _trace_summary(trace),
        "spans": [
            {
                "id": span.id,
                "step_key": span.step_key,
                "status": span.status,
                "attempt": span.attempt,
                "latency_ms": span.latency_ms,
                "started_at": _iso(span.started_at),
                "completed_at": _iso(span.completed_at),
                "total_tokens": span.total_tokens,
                "model": span.model,
                "error_type": span.error_type or None,
            }
            for span in spans
        ],
    }
