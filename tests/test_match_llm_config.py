"""匹配专用模型策略、截止时间与节点重试测试。"""
from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from langchain_core.exceptions import OutputParserException
from openai import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    BadRequestError,
    RateLimitError,
)

import app.core.llm as llm
import app.services.agent as agent
from app.core.config import Settings
from app.schemas.agent import JDAnalysis, MatchResult
from app.services.match_metrics import MatchStageError


def test_match_llm_factory_is_exposed():
    """匹配链路必须有独立入口，避免继续误用全局非匹配客户端。"""
    assert callable(getattr(llm, "get_match_llm", None))


@pytest.mark.parametrize(
    ("stage", "budget", "timeout"),
    [("extract", 111, 41), ("analyze", 222, 42), ("optimize", 333, 43)],
)
def test_match_llm_factory_applies_shared_policy(
    monkeypatch, stage, budget, timeout
):
    calls: list[tuple[str, dict]] = []

    def fake_init_chat_model(model, **kwargs):
        calls.append((model, kwargs))
        return object()

    monkeypatch.setattr(llm, "init_chat_model", fake_init_chat_model)
    monkeypatch.setattr(
        llm,
        "settings",
        SimpleNamespace(
            llm_model="policy-model",
            llm_provider="policy-provider",
            llm_api_key="secret",
            llm_base_url="https://llm.invalid/v1",
            llm_temperature=0.37,
            match_extract_max_tokens=111,
            match_analyze_max_tokens=222,
            match_optimize_max_tokens=333,
            match_extract_timeout_seconds=41,
            match_analyze_timeout_seconds=42,
            match_optimize_timeout_seconds=43,
        ),
    )
    llm.get_match_llm.cache_clear()

    try:
        result = llm.get_match_llm(stage)
    finally:
        llm.get_match_llm.cache_clear()

    assert result is not None
    assert calls == [
        (
            "policy-model",
            {
                "api_key": "secret",
                "model_provider": "policy-provider",
                "base_url": "https://llm.invalid/v1",
                "timeout": timeout,
                "temperature": 0.37,
                "max_tokens": budget,
                "max_retries": 0,
            },
        )
    ]


def test_match_policy_defaults_and_stage_timeout_inheritance():
    defaults = Settings(_env_file=None)
    assert defaults.match_total_timeout_seconds == 300
    assert defaults.match_extract_timeout_seconds == 300
    assert defaults.match_analyze_timeout_seconds == 300
    assert defaults.match_optimize_timeout_seconds == 300
    assert defaults.match_extract_max_tokens == 4096
    assert defaults.match_analyze_max_tokens == 4096
    assert defaults.match_optimize_max_tokens == 4096

    customized = Settings(_env_file=None, match_total_timeout_seconds=17)
    assert customized.match_extract_timeout_seconds == 17
    assert customized.match_analyze_timeout_seconds == 17
    assert customized.match_optimize_timeout_seconds == 17


@pytest.mark.asyncio
async def test_extract_node_uses_match_factory_and_json_mode(monkeypatch):
    factory_calls: list[tuple[str, dict]] = []
    structured_calls: list[tuple[type, str]] = []
    result = JDAnalysis(
        experiences=[],
        hard_skills=["Python"],
        soft_skills=[],
        plus=[],
        rigid=[],
    )

    class StructuredModel:
        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            return result

    class FakeModel:
        def with_structured_output(self, schema, method):
            structured_calls.append((schema, method))
            return StructuredModel()

    def fake_init_chat_model(model, **kwargs):
        factory_calls.append((model, kwargs))
        return FakeModel()

    monkeypatch.setattr(llm, "init_chat_model", fake_init_chat_model)
    llm.get_match_llm.cache_clear()
    try:
        state = await agent.jd_extract({"jd_text": "Need Python"})
    finally:
        llm.get_match_llm.cache_clear()

    assert state["jd_analyze_results"] == result
    assert factory_calls and factory_calls[0][1]["max_retries"] == 0
    assert structured_calls[-1] == (JDAnalysis, "json_mode")


@pytest.mark.asyncio
async def test_parse_retry_is_bounded_and_keeps_successful_upstream(monkeypatch):
    calls: list[str] = []
    analysis_attempts = 0
    jd = JDAnalysis(
        experiences=[], hard_skills=["Python"], soft_skills=[], plus=[], rigid=[]
    )
    match = MatchResult(role="Engineer", score=0.8, requirements=[], summary="ok")

    class StageModel:
        def __init__(self, stage):
            self.stage = stage

        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal analysis_attempts
            calls.append(self.stage)
            if self.stage == "extract":
                return jd
            if self.stage == "analyze":
                analysis_attempts += 1
                if analysis_attempts == 1:
                    raise OutputParserException("synthetic parse failure")
                return match
            return SimpleNamespace(content="# optimized", response_metadata={})

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "get_match_llm", lambda stage: StageModel(stage))

    result = await agent.run_match("resume", "jd")

    assert calls == ["extract", "analyze", "analyze", "optimize"]
    assert result == (["Python"], "# optimized", match.model_dump(exclude_none=True))


@pytest.mark.asyncio
async def test_parse_retry_never_exceeds_two_attempts(monkeypatch):
    calls = 0

    class AlwaysInvalid:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            raise OutputParserException("still invalid")

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: AlwaysInvalid())

    with pytest.raises(MatchStageError, match="jd_extract"):
        await agent.jd_extract({"jd_text": "jd"})

    assert calls == 2


@pytest.mark.asyncio
async def test_rate_limit_retries_once_and_honors_retry_after(monkeypatch):
    calls = 0
    sleeps: list[float] = []
    result = JDAnalysis(
        experiences=[], hard_skills=[], soft_skills=[], plus=[], rigid=[]
    )
    response = httpx.Response(
        429,
        headers={"retry-after": "0.25"},
        request=httpx.Request("POST", "https://llm.invalid/v1/chat"),
    )

    class RateLimitedOnce:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RateLimitError("slow down", response=response, body=None)
            return result

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: RateLimitedOnce())
    monkeypatch.setattr(agent.asyncio, "sleep", fake_sleep)

    state = await agent.jd_extract({"jd_text": "jd"})

    assert state["jd_analyze_results"] == result
    assert calls == 2
    assert sleeps == [0.25]


@pytest.mark.asyncio
async def test_generic_429_honors_retry_after(monkeypatch):
    calls = 0
    sleeps: list[float] = []
    result = JDAnalysis(
        experiences=[], hard_skills=[], soft_skills=[], plus=[], rigid=[]
    )
    response = httpx.Response(
        429,
        headers={"retry-after": "0.1"},
        request=httpx.Request("POST", "https://llm.invalid/v1/chat"),
    )
    error = APIStatusError("slow down", response=response, body=None)

    class RateLimitedOnce:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            if calls == 1:
                raise error
            return result

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: RateLimitedOnce())
    monkeypatch.setattr(agent.asyncio, "sleep", fake_sleep)

    await agent.jd_extract({"jd_text": "jd"})

    assert calls == 2
    assert sleeps == [0.1]


@pytest.mark.asyncio
async def test_stage_timeout_is_clipped_to_shared_remaining_deadline(monkeypatch):
    timeout_budgets: list[float] = []
    clock = iter([100.0, 104.0])
    jd = JDAnalysis(
        experiences=[], hard_skills=["Python"], soft_skills=[], plus=[], rigid=[]
    )
    match = MatchResult(role="Engineer", score=0.8, requirements=[], summary="ok")

    @asynccontextmanager
    async def fake_timeout(seconds):
        timeout_budgets.append(seconds)
        yield

    class ExtractModel:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            return jd

    class OneStageGraph:
        async def ainvoke(self, state):
            state = await agent.jd_extract(state)
            state["resume_match_results"] = match
            state["markdown_content"] = "# optimized"
            return state

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "build_graph", lambda: OneStageGraph())
    monkeypatch.setattr(agent, "get_match_llm", lambda stage: ExtractModel())
    monkeypatch.setattr(agent, "_monotonic", lambda: next(clock), raising=False)
    monkeypatch.setattr(agent.asyncio, "timeout", fake_timeout)
    monkeypatch.setattr(agent.settings, "match_total_timeout_seconds", 10)
    monkeypatch.setattr(agent.settings, "match_extract_timeout_seconds", 9)

    result = await agent.run_match("resume", "jd")

    assert result[1] == "# optimized"
    assert timeout_budgets == [10, 6]


@pytest.mark.asyncio
async def test_retry_after_beyond_deadline_fails_without_sleeping(monkeypatch):
    calls = 0
    sleeps: list[float] = []
    response = httpx.Response(
        429,
        headers={"retry-after": "5"},
        request=httpx.Request("POST", "https://llm.invalid/v1/chat"),
    )

    class AlwaysRateLimited:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            raise RateLimitError("slow down", response=response, body=None)

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: AlwaysRateLimited())
    monkeypatch.setattr(agent, "_monotonic", lambda: 100.0)
    monkeypatch.setattr(agent.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(agent.settings, "match_total_timeout_seconds", 1)
    monkeypatch.setattr(agent.settings, "match_extract_timeout_seconds", 1)

    with pytest.raises(MatchStageError, match="slow down"):
        await agent.jd_extract({"jd_text": "jd"})

    assert calls == 1
    assert sleeps == []


@pytest.mark.parametrize("status", [None, 503])
@pytest.mark.asyncio
async def test_recoverable_network_and_5xx_errors_retry_once(monkeypatch, status):
    calls = 0
    result = JDAnalysis(
        experiences=[], hard_skills=[], soft_skills=[], plus=[], rigid=[]
    )
    request = httpx.Request("POST", "https://llm.invalid/v1/chat")
    error = (
        APIConnectionError(request=request)
        if status is None
        else APIStatusError(
            "provider unavailable",
            response=httpx.Response(status, request=request),
            body=None,
        )
    )

    class FailsOnce:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            if calls == 1:
                raise error
            return result

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: FailsOnce())

    state = await agent.jd_extract({"jd_text": "jd"})

    assert state["jd_analyze_results"] == result
    assert calls == 2


@pytest.mark.parametrize("status", [None, 503])
@pytest.mark.asyncio
async def test_httpx_network_and_5xx_errors_retry_once(monkeypatch, status):
    calls = 0
    result = JDAnalysis(
        experiences=[], hard_skills=[], soft_skills=[], plus=[], rigid=[]
    )
    request = httpx.Request("POST", "https://llm.invalid/v1/chat")
    error = (
        httpx.ConnectError("connection failed", request=request)
        if status is None
        else httpx.HTTPStatusError(
            "provider unavailable",
            request=request,
            response=httpx.Response(status, request=request),
        )
    )

    class FailsOnce:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            if calls == 1:
                raise error
            return result

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: FailsOnce())

    state = await agent.jd_extract({"jd_text": "jd"})

    assert state["jd_analyze_results"] == result
    assert calls == 2


@pytest.mark.asyncio
async def test_optimize_rejects_length_truncation_before_mutating_state(monkeypatch):
    state = {
        "resume_text": "resume",
        "resume_match_results": MatchResult(
            role="Engineer", score=0.8, requirements=[], summary="ok"
        ),
        "keywords": ["Python"],
    }

    class TruncatedModel:
        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            return SimpleNamespace(
                content="# partial resume",
                response_metadata={"finish_reason": "length"},
            )

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: TruncatedModel())

    with pytest.raises(MatchStageError, match="截断"):
        await agent.keyword_optimize(state)

    assert "markdown_content" not in state


@pytest.mark.asyncio
async def test_wrong_structured_type_is_retried_once(monkeypatch):
    calls = 0
    result = JDAnalysis(
        experiences=[], hard_skills=[], soft_skills=[], plus=[], rigid=[]
    )

    class WrongTypeOnce:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            return {} if calls == 1 else result

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: WrongTypeOnce())

    state = await agent.jd_extract({"jd_text": "jd"})

    assert state["jd_analyze_results"] == result
    assert calls == 2


@pytest.mark.parametrize("error_type", [AuthenticationError, BadRequestError])
@pytest.mark.asyncio
async def test_auth_and_bad_request_errors_are_not_retried(monkeypatch, error_type):
    calls = 0
    request = httpx.Request("POST", "https://llm.invalid/v1/chat")
    status = 401 if error_type is AuthenticationError else 400
    error = error_type(
        "invalid request",
        response=httpx.Response(status, request=request),
        body=None,
    )

    class InvalidRequest:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            raise error

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: InvalidRequest())

    with pytest.raises(MatchStageError):
        await agent.jd_extract({"jd_text": "jd"})

    assert calls == 1


@pytest.mark.asyncio
async def test_exhausted_shared_deadline_skips_model_invocation(monkeypatch):
    calls = 0
    clock = iter([100.0, 111.0])

    @asynccontextmanager
    async def fake_timeout(seconds):  # noqa: ARG001
        yield

    class NeverCalled:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1

    class OneStageGraph:
        async def ainvoke(self, state):
            return await agent.jd_extract(state)

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "build_graph", lambda: OneStageGraph())
    monkeypatch.setattr(agent, "get_match_llm", lambda stage: NeverCalled())
    monkeypatch.setattr(agent, "_monotonic", lambda: next(clock, 111.0))
    monkeypatch.setattr(agent.asyncio, "timeout", fake_timeout)
    monkeypatch.setattr(agent.settings, "match_total_timeout_seconds", 10)
    monkeypatch.setattr(agent.settings, "match_extract_timeout_seconds", 10)

    with pytest.raises(MatchStageError, match="deadline exhausted"):
        await agent.run_match("resume", "jd")

    assert calls == 0


@pytest.mark.asyncio
async def test_stage_timeout_retries_when_total_budget_remains(monkeypatch):
    calls = 0
    timeout_entries = 0
    result = JDAnalysis(
        experiences=[], hard_skills=[], soft_skills=[], plus=[], rigid=[]
    )

    @asynccontextmanager
    async def fake_timeout(seconds):  # noqa: ARG001
        nonlocal timeout_entries
        timeout_entries += 1
        yield
        if timeout_entries == 1:
            raise TimeoutError("synthetic stage timeout")

    class FastModel:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            nonlocal calls
            calls += 1
            return result

    monkeypatch.setattr(agent, "get_match_llm", lambda stage: FastModel())
    monkeypatch.setattr(agent, "_monotonic", lambda: 100.0)
    monkeypatch.setattr(agent.asyncio, "timeout", fake_timeout)
    monkeypatch.setattr(agent.settings, "match_total_timeout_seconds", 10)
    monkeypatch.setattr(agent.settings, "match_extract_timeout_seconds", 2)

    state = await agent.jd_extract({"jd_text": "jd"})

    assert state["jd_analyze_results"] == result
    assert calls == 2


@pytest.mark.asyncio
async def test_all_match_nodes_use_stage_specific_factory_clients(monkeypatch):
    factory_budgets: list[int] = []
    jd = JDAnalysis(
        experiences=[], hard_skills=["Python"], soft_skills=[], plus=[], rigid=[]
    )
    match = MatchResult(role="Engineer", score=0.8, requirements=[], summary="ok")

    class FactoryModel:
        def __init__(self, budget):
            self.budget = budget

        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            if self.budget == 101:
                return jd
            if self.budget == 202:
                return match
            return SimpleNamespace(content="# optimized", response_metadata={})

    def fake_init_chat_model(model, **kwargs):  # noqa: ARG001
        factory_budgets.append(kwargs["max_tokens"])
        return FactoryModel(kwargs["max_tokens"])

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(llm, "init_chat_model", fake_init_chat_model)
    monkeypatch.setattr(llm.settings, "match_extract_max_tokens", 101)
    monkeypatch.setattr(llm.settings, "match_analyze_max_tokens", 202)
    monkeypatch.setattr(llm.settings, "match_optimize_max_tokens", 303)
    llm.get_match_llm.cache_clear()
    try:
        result = await agent.run_match("resume", "jd")
    finally:
        llm.get_match_llm.cache_clear()

    assert result[1] == "# optimized"
    assert factory_budgets == [101, 202, 303]
