"""统一可观测性（traces/spans）：写入、聚合口径、权限与归属隔离。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from conftest import auth_headers
from sqlalchemy import select

import app.core.database as database_module
from app.models.span import Span
from app.models.trace import Trace
from app.services.observability_stats import compute_observability, get_trace_detail
from app.services.trace_observability import (
    finish_trace,
    record_span,
    start_trace,
    trace_context,
)


async def _register(client, username: str, code: str) -> str:
    from app.models.registration_code import RegistrationCode

    async with database_module.AsyncSessionLocal() as db:
        db.add(
            RegistrationCode(
                code=code,
                grant_credits=50,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
        )
        await db.commit()
    response = await client.post(
        "/api/auth/register",
        json={"username": username, "password": "Pass#1234", "code": code},
    )
    assert response.status_code == 200, response.text
    return response.json()["token"]


@pytest.mark.asyncio
async def test_start_record_finish_persists_trace_and_spans(session):
    tid = await start_trace("user-1", "match")
    with trace_context(tid):
        await record_span(tid, step_key="jd_extract", status="success", latency_ms=120)
        await record_span(
            tid,
            step_key="resume_match",
            status="error",
            latency_ms=340,
            attempt=2,
            error_type="TimeoutError",
            total_tokens=1500,
        )
    await finish_trace(tid, status="error", error=TimeoutError("boom"))

    async with database_module.AsyncSessionLocal() as db:
        trace = await db.get(Trace, tid)
        spans = (
            await db.execute(select(Span).where(Span.trace_id == tid))
        ).scalars().all()

    assert trace.status == "error"
    assert trace.error_type == "TimeoutError"
    assert len(spans) == 2
    by_key = {s.step_key: s for s in spans}
    assert by_key["resume_match"].attempt == 2
    assert by_key["resume_match"].total_tokens == 1500
    assert by_key["resume_match"].error_type == "TimeoutError"


@pytest.mark.asyncio
async def test_aggregation_reports_nodes_endpoints_cost(session):
    tid = await start_trace("user-1", "match")
    await record_span(tid, step_key="jd_extract", status="success", latency_ms=100, total_tokens=200)
    await record_span(tid, step_key="keyword_optimize", status="success", latency_ms=300, total_tokens=800)
    await finish_trace(tid, status="success")

    async with database_module.AsyncSessionLocal() as db:
        data = await compute_observability(db, user_id="user-1", days=30)

    assert data["overview"]["total"] == 1
    assert data["overview"]["success_rate"] == 1.0
    assert data["overview"]["span_count"] == 2
    assert data["overview"]["total_tokens"] == 1000
    assert {n["step_key"] for n in data["nodes"]} == {"jd_extract", "keyword_optimize"}
    assert data["endpoints"][0]["endpoint"] == "match"
    assert data["cost"]["total_tokens"] == 1000
    assert data["cost"]["prompt_tokens"] == 0  # 未传 prompt_tokens
    assert data["cost"]["completion_tokens"] == 0


@pytest.mark.asyncio
async def test_node_aggregation_computes_p50_p95_and_error_types(session):
    tid = await start_trace("user-1", "ai.grammar")
    for latency in (10, 20, 30, 40, 100):
        await record_span(
            tid,
            step_key="grammar",
            status="success" if latency < 100 else "error",
            latency_ms=latency,
            error_type="ParseError" if latency >= 100 else "",
        )
    await finish_trace(tid, status="error")

    async with database_module.AsyncSessionLocal() as db:
        data = await compute_observability(db, user_id="user-1", days=30)

    node = data["nodes"][0]
    assert node["step_key"] == "grammar"
    assert node["calls"] == 5
    assert node["success"] == 4
    assert node["error"] == 1
    assert node["p50_latency_ms"] == 30
    assert node["p95_latency_ms"] == 100
    assert node["error_types"] == [["ParseError", 1]]


@pytest.mark.asyncio
async def test_trace_detail_is_user_scoped(session):
    tid = await start_trace("user-a", "match")
    await finish_trace(tid, status="success")

    async with database_module.AsyncSessionLocal() as db:
        own = await get_trace_detail(db, "user-a", tid)
        other = await get_trace_detail(db, "user-b", tid)

    assert own is not None
    assert own["trace"]["id"] == tid
    assert other is None


@pytest.mark.asyncio
async def test_observability_endpoint_requires_auth(client):
    response = await client.get("/api/observability?days=30")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_observability_endpoint_is_user_scoped(client, monkeypatch):
    async def _fake_run_match(master_text, jd_text):
        return (
            ["Python"],
            "# 定制简历\n",
            {"score": 0.8, "requirements": []},
        )

    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    token_a = await _register(client, "uobs-a", "UOBS-A")
    token_b = await _register(client, "uobs-b", "UOBS-B")

    await client.post(
        "/api/derived-resumes",
        json={"resumeText": "Python", "jdText": "后端工程师"},
        headers=auth_headers(token_a),
    )
    response = await client.get(
        "/api/observability?days=30&tz_offset=480",
        headers=auth_headers(token_b),
    )
    assert response.status_code == 200, response.text
    assert response.json()["overview"]["total"] == 0


@pytest.mark.asyncio
async def test_observability_rejects_unknown_endpoint(client):
    from app.models.registration_code import RegistrationCode

    async with database_module.AsyncSessionLocal() as db:
        db.add(
            RegistrationCode(
                code="OBS-EP",
                grant_credits=50,
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
        )
        await db.commit()
    token = (await client.post(
        "/api/auth/register",
        json={"username": "uobs-ep", "password": "Pass#1234", "code": "OBS-EP"},
    )).json()["token"]

    response = await client.get(
        "/api/observability?endpoint=not.a.real.endpoint",
        headers=auth_headers(token),
    )
    assert response.status_code == 422
