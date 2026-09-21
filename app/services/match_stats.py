"""简历匹配可观测性聚合。"""
from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.job import Job
from app.models.match_run import MatchRun
from app.models.match_run_step import MatchRunStep
from app.services.job_stats import clamp_days, clamp_tz_offset


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def _p95(values: list[int]) -> int | None:
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(len(values) * 0.95) - 1)]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _window(
    days: int, tz_offset: int
) -> tuple[int, int, date, date, datetime, datetime]:
    days = clamp_days(days)
    tz_offset = clamp_tz_offset(tz_offset)
    offset = timedelta(minutes=tz_offset)
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    end_date = (now_utc + offset).date()
    start_date = end_date - timedelta(days=days - 1)
    start_utc = datetime.combine(start_date, time.min) - offset
    end_utc = datetime.combine(end_date + timedelta(days=1), time.min) - offset
    return days, tz_offset, start_date, end_date, start_utc, end_utc


async def compute_match_observability(
    db: AsyncSession,
    user_id: str,
    days: int = 30,
    tz_offset: int = 480,
) -> dict[str, Any]:
    days, tz_offset, start_date, end_date, start_utc, end_utc = _window(
        days, tz_offset
    )
    runs = (
        await db.execute(
            select(MatchRun)
            .where(
                MatchRun.user_id == user_id,
                MatchRun.started_at >= start_utc,
                MatchRun.started_at < end_utc,
            )
            .order_by(MatchRun.started_at.asc())
        )
    ).scalars().all()
    steps = (
        await db.execute(
            select(MatchRunStep)
            .join(MatchRun, MatchRun.id == MatchRunStep.match_run_id)
            .where(
                MatchRun.user_id == user_id,
                MatchRun.started_at >= start_utc,
                MatchRun.started_at < end_utc,
            )
        )
    ).scalars().all()

    successes = sum(r.status == "success" for r in runs)
    errors = sum(r.status == "error" for r in runs)
    running = sum(r.status == "running" for r in runs)
    latencies = [r.latency_ms for r in runs if r.status != "running"]
    scored = [r.match_score for r in runs if r.match_score is not None]

    daily: dict[date, dict[str, Any]] = {
        start_date + timedelta(days=i): {
            "date": (start_date + timedelta(days=i)).isoformat(),
            "total": 0,
            "success": 0,
            "error": 0,
            "avg_latency_ms": None,
        }
        for i in range(days)
    }
    daily_latency: dict[date, list[int]] = {day: [] for day in daily}
    for run in runs:
        local_day = (run.started_at + timedelta(minutes=tz_offset)).date()
        if local_day not in daily:
            continue
        point = daily[local_day]
        point["total"] += 1
        if run.status == "success":
            point["success"] += 1
        if run.status == "error":
            point["error"] += 1
        if run.status != "running":
            daily_latency[local_day].append(run.latency_ms)
    for day, values in daily_latency.items():
        daily[day]["avg_latency_ms"] = (
            round(sum(values) / len(values)) if values else None
        )

    step_summary: dict[str, dict[str, Any]] = {}
    for step in steps:
        item = step_summary.setdefault(
            step.step_key,
            {"step_key": step.step_key, "calls": 0, "success": 0, "error": 0, "latencies": []},
        )
        item["calls"] += 1
        item[step.status] = item.get(step.status, 0) + 1
        item["latencies"].append(step.latency_ms)
    step_rows = []
    for item in step_summary.values():
        values = item.pop("latencies")
        calls = item["calls"]
        step_rows.append(
            {
                **item,
                "success_rate": _rate(item["success"], calls),
                "avg_latency_ms": round(sum(values) / len(values)) if values else None,
            }
        )
    step_rows.sort(key=lambda row: row["step_key"])

    quality = {
        "matched": sum(r.matched_count for r in runs),
        "weak": sum(r.weak_count for r in runs),
        "missing": sum(r.missing_count for r in runs),
        "unsupported": sum(r.unsupported_count for r in runs),
    }
    quality["total_requirements"] = sum(quality.values())
    applied_runs = (
        await db.execute(
            select(MatchRun.id)
            .join(Job, MatchRun.job_id == Job.id)
            .where(
                MatchRun.user_id == user_id,
                MatchRun.started_at >= start_utc,
                MatchRun.started_at < end_utc,
                MatchRun.status == "success",
                Job.status == "applied",
            )
        )
    ).all()

    recent_rows = (
        await db.execute(
            select(MatchRun, Job.title, Job.company, Job.status)
            .outerjoin(Job, MatchRun.job_id == Job.id)
            .where(
                MatchRun.user_id == user_id,
                MatchRun.started_at >= start_utc,
                MatchRun.started_at < end_utc,
            )
            .order_by(MatchRun.started_at.desc())
            .limit(20)
        )
    ).all()
    recent_runs = [
        _run_summary(run, title, company, job_status)
        for run, title, company, job_status in recent_rows
    ]

    return {
        "range": {
            "days": days,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "tz_offset": tz_offset,
        },
        "overview": {
            "total": len(runs),
            "success": successes,
            "error": errors,
            "running": running,
            "success_rate": _rate(successes, len(runs)),
            "avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
            "p95_latency_ms": _p95(latencies),
            "total_tokens": sum(r.total_tokens for r in runs),
            "avg_tokens": round(sum(r.total_tokens for r in runs) / len(runs)) if runs else None,
            "avg_score": round(sum(scored) / len(scored), 4) if scored else None,
        },
        "daily": list(daily.values()),
        "steps": step_rows,
        "quality": quality,
        "outcome": {
            "success_runs": successes,
            "applied_runs": len(applied_runs),
            "applied_rate": _rate(len(applied_runs), successes),
        },
        "recent_runs": recent_runs,
    }


def _run_summary(
    run: MatchRun,
    title: str | None,
    company: str | None,
    job_status: str | None,
) -> dict[str, Any]:
    return {
        "id": run.id,
        "job_id": run.job_id,
        "job_title": title or "",
        "company": company or "",
        "job_status": job_status,
        "status": run.status,
        "score": run.match_score,
        "latency_ms": run.latency_ms,
        "total_tokens": run.total_tokens,
        "started_at": _iso(run.started_at),
        "completed_at": _iso(run.completed_at),
        "error_type": run.error_type or None,
    }


async def get_match_run_detail(
    db: AsyncSession, user_id: str, run_id: str
) -> dict[str, Any] | None:
    row = (
        await db.execute(
            select(MatchRun, Job.title, Job.company, Job.status)
            .outerjoin(Job, MatchRun.job_id == Job.id)
            .where(MatchRun.id == run_id, MatchRun.user_id == user_id)
        )
    ).first()
    if row is None:
        return None
    run, title, company, job_status = row
    steps = (
        await db.execute(
            select(MatchRunStep)
            .where(MatchRunStep.match_run_id == run.id)
            .order_by(MatchRunStep.started_at.asc(), MatchRunStep.attempt.asc())
        )
    ).scalars().all()
    return {
        "run": _run_summary(run, title, company, job_status),
        "quality": {
            "matched": run.matched_count,
            "weak": run.weak_count,
            "missing": run.missing_count,
            "unsupported": run.unsupported_count,
            "total_requirements": run.matched_count
            + run.weak_count
            + run.missing_count
            + run.unsupported_count,
        },
        "usage": {
            "prompt_tokens": run.prompt_tokens,
            "completion_tokens": run.completion_tokens,
            "total_tokens": run.total_tokens,
            "model": run.model,
        },
        "error": {
            "type": run.error_type or None,
            "message": run.error_message or None,
        },
        "steps": [
            {
                "step_key": step.step_key,
                "status": step.status,
                "attempt": step.attempt,
                "latency_ms": step.latency_ms,
                "started_at": _iso(step.started_at),
                "completed_at": _iso(step.completed_at),
                "error_type": step.error_type or None,
            }
            for step in steps
        ],
    }
