"""LLM 用量台账（Plan.md R1）测试。

覆盖目标：
1. token 汇总逻辑（多模型累加、缺失 total 时补齐、无 usage 时不伪造）；
2. `track_llm` 成功 / 失败都要落库，且失败时异常原样向上抛（不改变既有错误处理）；
3. 台账写入失败不得影响业务（旁路数据原则）；
4. 聚合查询按用户与端点过滤正确；
5. 路由级接线：AI 语法检查、简历匹配、话术生成三条链路确实写入台账（防埋点遗漏）。
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from sqlalchemy import delete, select

from app.core.timeutils import utcnow
from app.models.llm_usage import (
    ENDPOINT_AI_GRAMMAR,
    ENDPOINT_COVER_LETTER,
    ENDPOINT_MATCH,
    USAGE_STATUS_ERROR,
    USAGE_STATUS_SUCCESS,
    LlmUsage,
)
from app.models.registration_code import RegistrationCode
from app.services.usage import (
    _summarize_usage,
    aggregate_usage,
    record_llm_usage,
    track_llm,
)
from tests.conftest import auth_headers


class _UsageFakeModel(FakeListChatModel):
    """带 usage_metadata 的假模型：走真实 Runnable 调用链以触发 usage 回调。

    两个关键点（决定本测试能否反映真实行为）：
    - usage 由 `on_llm_end` 从 AIMessage 收集，故必须走 `ainvoke` 而不是直接调服务函数；
    - 回调以「模型名」为 key 汇总，模型名取自 `response_metadata["model_name"]`，
      缺失时 token 不会被统计——真实厂商响应都会带该字段，这里必须模拟出来。
    """

    in_tokens: int = 11
    out_tokens: int = 7

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # noqa: ARG002
        """覆盖 `_generate`（而非 `_call`）：基类会把 `_call` 的返回值当字符串，
        无法附加 usage/response 元数据。"""
        msg = AIMessage(
            content="ok",
            usage_metadata={
                "input_tokens": self.in_tokens,
                "output_tokens": self.out_tokens,
                "total_tokens": self.in_tokens + self.out_tokens,
            },
            response_metadata={"model_name": "fake-model"},
        )
        return ChatResult(
            generations=[ChatGeneration(message=msg)],
            llm_output={"model_name": "fake-model"},
        )


async def _emit_usage(input_tokens: int = 11, output_tokens: int = 7) -> None:
    """在 track_llm 上下文中发起一次带 usage 的 LLM 调用。"""
    async with track_llm(ENDPOINT_MATCH, user_id="u1"):
        await _UsageFakeModel(
            responses=["ok"], in_tokens=input_tokens, out_tokens=output_tokens
        ).ainvoke("hello")


# --------------------------------------------------------------------------
# 1. token 汇总
# --------------------------------------------------------------------------
def test_summarize_usage_aggregates_multiple_models():
    prompt, completion, total, model = _summarize_usage(
        {
            "model-a": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            "model-b": {"input_tokens": 20, "output_tokens": 10, "total_tokens": 30},
        }
    )
    assert (prompt, completion, total) == (30, 15, 45)
    # 多模型时取首个（明细靠日志排查）
    assert model == "model-a"


def test_summarize_usage_fills_missing_total():
    prompt, completion, total, _ = _summarize_usage(
        {"m": {"input_tokens": 3, "output_tokens": 4, "total_tokens": 0}}
    )
    assert (prompt, completion, total) == (3, 4, 7)


def test_summarize_usage_empty_metadata():
    # 厂商未回传 usage：不估算、不伪造
    assert _summarize_usage({}) == (0, 0, 0, "")
    assert _summarize_usage(None) == (0, 0, 0, "")


# --------------------------------------------------------------------------
# 2. track_llm 成功 / 失败落库
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_track_llm_records_success(session):
    await _emit_usage(input_tokens=11, output_tokens=7)

    rows = (await session.execute(select(LlmUsage))).scalars().all()
    assert len(rows) == 1
    row = rows[0]
    assert row.endpoint == ENDPOINT_MATCH
    assert row.user_id == "u1"
    assert row.status == USAGE_STATUS_SUCCESS
    assert row.error_type == ""
    assert (row.prompt_tokens, row.completion_tokens, row.total_tokens) == (11, 7, 18)
    assert row.model == "fake-model"
    assert row.latency_ms >= 0


@pytest.mark.asyncio
async def test_track_llm_records_error_and_reraises(session):
    class _Boom(RuntimeError):
        pass

    with pytest.raises(_Boom):
        async with track_llm(ENDPOINT_COVER_LETTER, user_id="u2"):
            raise _Boom("llm timeout")

    row = (await session.execute(select(LlmUsage))).scalars().one()
    assert row.status == USAGE_STATUS_ERROR
    assert row.error_type == "_Boom"
    assert row.endpoint == ENDPOINT_COVER_LETTER


@pytest.mark.asyncio
async def test_track_llm_records_error_without_tokens(session):
    """失败也要留痕：即使没有 token 数据，调用次数与状态也必须可统计。"""
    with pytest.raises(ValueError):
        async with track_llm(ENDPOINT_AI_GRAMMAR, user_id="u3"):
            raise ValueError("bad json")

    row = (await session.execute(select(LlmUsage))).scalars().one()
    assert row.status == USAGE_STATUS_ERROR
    assert row.total_tokens == 0


# --------------------------------------------------------------------------
# 3. 台账写入失败不影响业务（旁路数据原则）
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_usage_write_failure_does_not_break_business(monkeypatch):
    import app.services.usage as usage_module

    def _boom(*args, **kwargs):  # noqa: ARG001
        raise RuntimeError("db down")

    monkeypatch.setattr(usage_module, "AsyncSessionLocal", _boom)

    # 业务调用必须照常完成：异常被吞掉，只留日志
    async with track_llm(ENDPOINT_MATCH, user_id="u4"):
        pass


@pytest.mark.asyncio
async def test_record_llm_usage_swallows_exception(monkeypatch):
    import app.services.usage as usage_module

    def _boom(*args, **kwargs):  # noqa: ARG001
        raise RuntimeError("boom")

    monkeypatch.setattr(usage_module, "AsyncSessionLocal", _boom)
    # 不应抛出
    await record_llm_usage(user_id="u5", endpoint=ENDPOINT_MATCH)


# --------------------------------------------------------------------------
# 4. 聚合查询
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_aggregate_usage_groups_by_endpoint_and_filters_user(session):
    await record_llm_usage(
        user_id="ua", endpoint=ENDPOINT_MATCH, prompt_tokens=10,
        completion_tokens=5, total_tokens=15,
    )
    await record_llm_usage(
        user_id="ua", endpoint=ENDPOINT_MATCH, prompt_tokens=4,
        completion_tokens=1, total_tokens=5,
    )
    await record_llm_usage(
        user_id="ua", endpoint=ENDPOINT_AI_GRAMMAR, prompt_tokens=1,
        completion_tokens=1, total_tokens=2,
    )
    await record_llm_usage(
        user_id="ub", endpoint=ENDPOINT_MATCH, prompt_tokens=100,
        completion_tokens=100, total_tokens=200,
    )

    rows = await aggregate_usage(user_id="ua")
    by_endpoint = {r["endpoint"]: r for r in rows}
    assert by_endpoint[ENDPOINT_MATCH]["calls"] == 2
    assert by_endpoint[ENDPOINT_MATCH]["total_tokens"] == 20
    assert by_endpoint[ENDPOINT_AI_GRAMMAR]["calls"] == 1

    total = await aggregate_usage(user_id="ua", group_by_endpoint=False)
    assert len(total) == 1
    assert total[0]["calls"] == 3
    assert total[0]["endpoint"] is None


@pytest.mark.asyncio
async def test_aggregate_usage_respects_time_window(session):
    await record_llm_usage(user_id="uc", endpoint=ENDPOINT_MATCH, total_tokens=9)

    rows = await aggregate_usage(user_id="uc")
    assert rows[0]["calls"] == 1

    assert await aggregate_usage(user_id="uc", since=utcnow() + timedelta(days=1)) == []


# --------------------------------------------------------------------------
# 5. 路由级接线（防埋点遗漏）
# --------------------------------------------------------------------------
async def _ensure_code(session, code: str) -> None:
    res = await session.execute(
        select(RegistrationCode).where(RegistrationCode.code == code)
    )
    if res.scalars().first() is None:
        session.add(
            RegistrationCode(
                code=code, grant_credits=50, expires_at=utcnow() + timedelta(days=1)
            )
        )
        await session.commit()


async def _reset_usage(session) -> None:
    """清空台账：路由测试断言「本次请求产生的记录」，避免其他用例残留造成假阳性。"""
    await session.execute(delete(LlmUsage))
    await session.commit()


async def _login(client, session, username: str, code: str) -> str:
    await _ensure_code(session, code)
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "password": "Pass#1234", "code": code},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.mark.asyncio
async def test_grammar_route_records_usage(client, session, monkeypatch):
    token = await _login(client, session, "usage1", "USG1")
    await _reset_usage(session)

    async def _fake_grammar_check(content):  # noqa: ARG001
        return '{"errors": []}'

    monkeypatch.setattr("app.api.ai.ai_proxy.grammar_check", _fake_grammar_check)

    r = await client.post(
        "/api/ai/grammar", json={"content": "hello"}, headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text

    rows = (await session.execute(select(LlmUsage))).scalars().all()
    assert [x.endpoint for x in rows] == [ENDPOINT_AI_GRAMMAR]
    assert rows[0].status == USAGE_STATUS_SUCCESS
    assert rows[0].user_id


@pytest.mark.asyncio
async def test_match_route_records_usage(client, session, monkeypatch):
    token = await _login(client, session, "usage2", "USG2")
    await _reset_usage(session)

    async def _fake_run_match(master_text, jd_text):  # noqa: ARG001
        return ["kw"], "# 优化后简历", None

    monkeypatch.setattr("app.api.match.run_match", _fake_run_match)

    r = await client.post(
        "/api/derived-resumes",
        json={"resumeText": "# 简历", "jdText": "# 岗位"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    rows = (await session.execute(select(LlmUsage))).scalars().all()
    assert [x.endpoint for x in rows] == [ENDPOINT_MATCH]


@pytest.mark.asyncio
async def test_cover_letter_route_records_usage(client, session, monkeypatch):
    token = await _login(client, session, "usage3", "USG3")
    await _reset_usage(session)

    async def _fake_run_cover_letter(jd_text, resume_text, scene):  # noqa: ARG001
        return "尊敬的招聘经理：..."

    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    r = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# 简历", "jd_text": "# 岗位", "scene": "greeting"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    rows = (await session.execute(select(LlmUsage))).scalars().all()
    assert [x.endpoint for x in rows] == [ENDPOINT_COVER_LETTER]
