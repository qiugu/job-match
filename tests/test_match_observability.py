"""简历匹配可观测性：运行台账、用量关联和用户隔离。"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from conftest import auth_headers
from sqlalchemy import select

import app.core.database as database_module
from app.models.llm_usage import LlmUsage
from app.models.match_run import MatchRun


async def _register(client, username: str, code: str) -> str:
    from datetime import timedelta

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


async def _fake_run_match(master_text: str, jd_text: str):
    return (
        ["Python", "FastAPI"],
        "# 定制简历\n- 负责服务端开发\n",
        {
            "role": "后端工程师",
            "score": 0.8,
            "requirements": [
                {
                    "requirement": "Python",
                    "evidence": "服务端开发",
                    "strength": "matched",
                    "suggestion": "",
                }
            ],
            "summary": "匹配良好",
        },
    )


async def _failing_run_match(master_text: str, jd_text: str):
    raise RuntimeError("模型响应超时")


@pytest.mark.asyncio
async def test_match_run_model_has_nullable_job_and_usage_link(session):
    run = MatchRun(user_id="user-1", status="running")
    session.add(run)
    await session.commit()
    await session.refresh(run)

    session.add(LlmUsage(user_id="user-1", endpoint="match", match_run_id=run.id))
    await session.commit()

    saved = await session.get(MatchRun, run.id)
    usage = (await session.execute(select(LlmUsage))).scalars().one()
    assert saved is not None
    assert saved.job_id is None
    assert usage.match_run_id == run.id


@pytest.mark.asyncio
async def test_create_match_persists_successful_observability_run(client, monkeypatch):
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    token = await _register(client, "obs-success", "OBS-SUCCESS")

    response = await client.post(
        "/api/derived-resumes",
        json={"resumeText": "Python 后端开发", "jdText": "FastAPI 工程师"},
        headers=auth_headers(token),
    )
    assert response.status_code == 200, response.text

    async with database_module.AsyncSessionLocal() as db:
        run = (await db.execute(select(MatchRun))).scalars().one()
        usage = (await db.execute(select(LlmUsage))).scalars().one()

    assert run.status == "success"
    assert run.derived_resume_id == response.json()["id"]
    assert run.job_id == response.json()["jobId"]
    assert usage.match_run_id == run.id

    stats = await client.get(
        "/api/derived-resumes/observability?days=30&tz_offset=480",
        headers=auth_headers(token),
    )
    assert stats.status_code == 200, stats.text
    assert stats.json()["overview"]["total"] == 1
    assert stats.json()["overview"]["success"] == 1
    assert stats.json()["quality"]["matched"] == 1


@pytest.mark.asyncio
async def test_failed_match_keeps_error_run_and_usage_link(client, monkeypatch):
    monkeypatch.setattr("app.api.match.run_match", _failing_run_match)
    token = await _register(client, "obs-error", "OBS-ERROR")

    response = await client.post(
        "/api/derived-resumes",
        json={"resumeText": "Python", "jdText": "后端工程师"},
        headers=auth_headers(token),
    )
    assert response.status_code == 503, response.text

    async with database_module.AsyncSessionLocal() as db:
        run = (await db.execute(select(MatchRun))).scalars().one()
        usage = (await db.execute(select(LlmUsage))).scalars().one()

    assert run.status == "error"
    assert run.error_type == "RuntimeError"
    assert usage.match_run_id == run.id


@pytest.mark.asyncio
async def test_observability_endpoint_is_user_scoped(client, monkeypatch):
    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)
    token_a = await _register(client, "obs-a", "OBS-A")
    token_b = await _register(client, "obs-b", "OBS-B")

    await client.post(
        "/api/derived-resumes",
        json={"resumeText": "Python", "jdText": "后端工程师"},
        headers=auth_headers(token_a),
    )
    response = await client.get(
        "/api/derived-resumes/observability?days=30&tz_offset=480",
        headers=auth_headers(token_b),
    )
    assert response.status_code == 200, response.text
    assert response.json()["overview"]["total"] == 0
