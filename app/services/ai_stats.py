"""AI 端点可观测性聚合：翻译为主，兼顾管理员跨用户视图。

设计对齐 `app/services/match_stats.py`（同一套窗口/比率/p95 口径），因为两个
观测面板在同一页面相邻呈现，口径不一致会立刻被用户看出来。

数据来源是 `llm_usage` 台账 + 其 `detail` 列（JSON 文本，见 models/llm_usage.py）：
翻译的字段统计就存在这里，解析失败一律降级为空摘要而不是抛异常——观测面板
不能因为一条脏记录整页白屏。

隐私边界：本模块只处理字段路径与计数，不读取、不返回任何简历正文。
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.llm_usage import (
    ENDPOINT_AI_TRANSLATE,
    USAGE_STATUS_SUCCESS,
    LlmUsage,
)
from app.services.job_stats import clamp_days, clamp_tz_offset


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def _p95(values: list[int]) -> int | None:
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(len(values) * 0.95) - 1)]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _window(days: int, tz_offset: int):
    """时间窗与 `match_stats._window` 同口径（那边是私有函数，这里独立实现以免耦合）。

    台账里的 created_at 是 UTC naive，按用户时区换算成「本地自然日」后再分组，
    否则东八区晚间调用会被算到前一天。
    """
    days = clamp_days(days)
    tz_offset = clamp_tz_offset(tz_offset)
    offset = timedelta(minutes=tz_offset)
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    end_date = (now_utc + offset).date()
    start_date = end_date - timedelta(days=days - 1)
    start_utc = datetime.combine(start_date, time.min) - offset
    end_utc = datetime.combine(end_date + timedelta(days=1), time.min) - offset
    return days, tz_offset, start_date, end_date, start_utc, end_utc


def parse_detail(text: str) -> dict:
    """解析 detail 列，任何异常都降级为空摘要（脏记录不能让整页崩）。"""
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _safe_group(name: str) -> str:
    """分组名来自字段路径，清洗掉换行等字符，避免破坏前端布局。"""
    cleaned = "".join(ch for ch in name if ch.isalnum() or ch in "_ -")[:32]
    return cleaned or "unknown"


def _call_summary(row: LlmUsage) -> dict[str, Any]:
    detail = parse_detail(row.detail)
    return {
        "id": row.id,
        "endpoint": row.endpoint,
        "user_id": row.user_id,
        "status": row.status,
        "error_type": row.error_type or None,
        "model": row.model,
        "latency_ms": row.latency_ms,
        "total_tokens": row.total_tokens,
        "prompt_version": row.prompt_version or None,
        "created_at": _iso(row.created_at),
        "detail_available": bool(detail),
        "summary": {
            "target_lang": detail.get("targetLang"),
            "fields_total": int(detail.get("fieldsTotal") or 0),
            "fields_translated": int(detail.get("fieldsTranslated") or 0),
            "fields_unchanged": int(detail.get("fieldsUnchanged") or 0),
            "fields_missing": int(detail.get("fieldsMissing") or 0),
        }
        if detail
        else None,
    }


async def compute_translation_observability(
    db: AsyncSession,
    days: int = 30,
    tz_offset: int = 480,
    user_id: str | None = None,
) -> dict[str, Any]:
    """翻译端点观测：KPI + 按日趋势 + 未变化分组 + 最近调用。

    `user_id=None` 表示跨用户（管理员视角）；给定 user_id 时只看该用户，
    两个视角共用同一段 SQL，避免「管理员页面算一套、用户页面算另一套」。
    """
    days, tz_offset, start_date, end_date, start_utc, end_utc = _window(
        days, tz_offset
    )
    stmt = select(LlmUsage).where(
        LlmUsage.endpoint == ENDPOINT_AI_TRANSLATE,
        LlmUsage.created_at >= start_utc,
        LlmUsage.created_at < end_utc,
    )
    if user_id is not None:
        stmt = stmt.where(LlmUsage.user_id == user_id)
    rows = (
        await db.execute(stmt.order_by(LlmUsage.created_at.asc()))
    ).scalars().all()

    successes = sum(row.status == USAGE_STATUS_SUCCESS for row in rows)
    errors = len(rows) - successes
    latencies = [row.latency_ms for row in rows]

    fields_total = fields_translated = fields_unchanged = fields_missing = 0
    groups: dict[str, int] = {}
    for row in rows:
        detail = parse_detail(row.detail)
        fields_total += int(detail.get("fieldsTotal") or 0)
        fields_translated += int(detail.get("fieldsTranslated") or 0)
        fields_unchanged += int(detail.get("fieldsUnchanged") or 0)
        fields_missing += int(detail.get("fieldsMissing") or 0)
        for name, count in (detail.get("unchangedGroups") or {}).items():
            key = _safe_group(str(name))
            groups[key] = groups.get(key, 0) + int(count or 0)

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
    for row in rows:
        local_day = (row.created_at + timedelta(minutes=tz_offset)).date()
        point = daily.get(local_day)
        if point is None:
            continue
        point["total"] += 1
        point["success" if row.status == USAGE_STATUS_SUCCESS else "error"] += 1
        point["total_tokens"] += row.total_tokens

    recent = sorted(rows, key=lambda item: item.created_at, reverse=True)[:20]

    # 未变化占比的分母用「已返回字段数」：缺失字段由前端回退原文，
    # 混进来会把「LLM 漏返回」误记成「策略性保留」。
    returned_fields = fields_translated + fields_unchanged
    return {
        "range": {
            "days": days,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "tz_offset": tz_offset,
        },
        "scope": "global" if user_id is None else "self",
        "overview": {
            "total": len(rows),
            "success": successes,
            "error": errors,
            "success_rate": _rate(successes, len(rows)),
            "avg_latency_ms": round(sum(latencies) / len(latencies))
            if latencies
            else None,
            "p95_latency_ms": _p95(latencies),
            "total_tokens": sum(row.total_tokens for row in rows),
            "fields_total": fields_total,
            "fields_translated": fields_translated,
            "fields_unchanged": fields_unchanged,
            "fields_missing": fields_missing,
            "unchanged_rate": _rate(fields_unchanged, returned_fields),
            "avg_fields_per_call": round(fields_total / len(rows), 1) if rows else None,
        },
        "daily": list(daily.values()),
        "unchanged_groups": [
            {"group": name, "count": count}
            for name, count in sorted(
                groups.items(), key=lambda item: item[1], reverse=True
            )
        ],
        "recent_calls": [_call_summary(row) for row in recent],
    }


async def get_translation_call_detail(
    db: AsyncSession, call_id: str, user_id: str | None = None
) -> dict[str, Any] | None:
    """单次翻译详情。`user_id` 不为 None 时校验归属，他人记录返回 None（对外 404）。"""
    stmt = select(LlmUsage).where(
        LlmUsage.id == call_id,
        LlmUsage.endpoint == ENDPOINT_AI_TRANSLATE,
    )
    if user_id is not None:
        stmt = stmt.where(LlmUsage.user_id == user_id)
    row = (await db.execute(stmt)).scalars().first()
    if row is None:
        return None

    detail = parse_detail(row.detail)
    return {
        "call": _call_summary(row),
        "detail": detail or None,
        "unchanged_keys": [
            str(key) for key in (detail.get("unchangedKeys") or [])[:20]
        ],
        "unchanged_keys_truncated": int(detail.get("unchangedKeysTruncated") or 0),
        "truncated": bool(detail.get("truncated") or False),
    }


async def compute_global_ai_observability(
    db: AsyncSession,
    days: int = 30,
    tz_offset: int = 480,
    endpoint: str | None = None,
) -> dict[str, Any]:
    """管理员跨用户视图：按端点分布 + 失败清单 + 最近调用（含翻译摘要）。

    端点分布走 SQL 聚合而非「把窗口内的行全读进内存再数」：全局视图没有 user_id
    收窄范围，调用量一大就会把整张台账读进进程内存。失败与最近调用各有 20 条上限，
    因此可以安全地取明细行。
    """
    days, tz_offset, start_date, end_date, start_utc, end_utc = _window(
        days, tz_offset
    )
    conditions = [
        LlmUsage.created_at >= start_utc,
        LlmUsage.created_at < end_utc,
    ]
    if endpoint:
        conditions.append(LlmUsage.endpoint == endpoint)

    aggregate_rows = (
        await db.execute(
            select(
                LlmUsage.endpoint,
                func.count(LlmUsage.id),
                func.sum(case((LlmUsage.status == USAGE_STATUS_SUCCESS, 1), else_=0)),
                func.coalesce(func.sum(LlmUsage.total_tokens), 0),
                func.coalesce(func.avg(LlmUsage.latency_ms), 0),
            )
            .where(*conditions)
            .group_by(LlmUsage.endpoint)
        )
    ).all()

    endpoints = []
    total = success_count = error_count = token_sum = 0
    for name, calls, success, tokens, avg_latency in aggregate_rows:
        calls = int(calls or 0)
        success = int(success or 0)
        endpoints.append(
            {
                "endpoint": name or "unknown",
                "calls": calls,
                "success": success,
                "error": calls - success,
                "total_tokens": int(tokens or 0),
                "success_rate": _rate(success, calls),
                "avg_latency_ms": round(float(avg_latency or 0)),
            }
        )
        total += calls
        success_count += success
        error_count += calls - success
        token_sum += int(tokens or 0)
    endpoints.sort(key=lambda row: row["calls"], reverse=True)

    failure_rows = (
        await db.execute(
            select(LlmUsage)
            .where(*conditions, LlmUsage.status != USAGE_STATUS_SUCCESS)
            .order_by(LlmUsage.created_at.desc())
            .limit(20)
        )
    ).scalars().all()
    recent_rows = (
        await db.execute(
            select(LlmUsage)
            .where(*conditions)
            .order_by(LlmUsage.created_at.desc())
            .limit(20)
        )
    ).scalars().all()

    return {
        "range": {
            "days": days,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "tz_offset": tz_offset,
        },
        "overview": {
            "total": total,
            "success": success_count,
            "error": error_count,
            "total_tokens": token_sum,
            "endpoints": len(endpoints),
        },
        "endpoints": endpoints,
        "failures": [_call_summary(row) for row in failure_rows],
        "recent_calls": [_call_summary(row) for row in recent_rows],
    }
