"""简历匹配工作流的失败短路与成功顺序回归测试。"""
from __future__ import annotations

import pytest

import app.services.agent as agent
from app.schemas.agent import JDAnalysis, MatchResult


def _jd_analysis() -> JDAnalysis:
    return JDAnalysis(
        experiences=["3 年后端经验"],
        hard_skills=["Python"],
        soft_skills=["沟通"],
        plus=[],
        rigid=[],
    )


def _match_result() -> MatchResult:
    return MatchResult(
        role="后端工程师",
        score=0.8,
        requirements=[],
        summary="匹配",
    )


@pytest.mark.asyncio
async def test_run_match_stops_when_extract_node_raises(monkeypatch):
    calls: list[str] = []

    async def failed_extract(state):  # noqa: ARG001
        calls.append("extract")
        raise RuntimeError("synthetic extraction failure")

    async def forbidden_match(state):  # noqa: ARG001
        calls.append("match")
        raise AssertionError("upstream failure must stop the graph")

    async def forbidden_optimize(state):  # noqa: ARG001
        calls.append("optimize")
        raise AssertionError("upstream failure must stop the graph")

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "jd_extract", failed_extract)
    monkeypatch.setattr(agent, "resume_match", forbidden_match)
    monkeypatch.setattr(agent, "keyword_optimize", forbidden_optimize)

    with pytest.raises(RuntimeError, match="synthetic extraction failure"):
        await agent.run_match("resume", "jd")

    assert calls == ["extract"]


@pytest.mark.asyncio
async def test_real_extract_failure_stops_downstream_nodes(monkeypatch):
    """覆盖 jd_extract 当前吞异常并填空对象后继续执行的真实故障。"""
    calls: list[str] = []
    error_logs: list[str] = []
    secret = "PRIVATE JD BODY"

    def capture_error(message, *args, **kwargs):  # noqa: ARG001
        error_logs.append(message % args)

    class FailingStructuredModel:
        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            calls.append("extract")
            raise RuntimeError(f"synthetic structured extraction failure: {secret}")

    class FakeModel:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return FailingStructuredModel()

    async def forbidden_match(state):  # noqa: ARG001
        calls.append("match")
        raise AssertionError("upstream failure must stop the graph")

    async def forbidden_optimize(state):  # noqa: ARG001
        calls.append("optimize")
        raise AssertionError("upstream failure must stop the graph")

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "model", FakeModel())
    monkeypatch.setattr(agent, "resume_match", forbidden_match)
    monkeypatch.setattr(agent, "keyword_optimize", forbidden_optimize)
    monkeypatch.setattr(agent.logger, "error", capture_error)
    monkeypatch.setattr(agent.logger, "exception", capture_error)

    with pytest.raises(RuntimeError, match="jd_extract"):
        await agent.run_match("resume", "jd")

    assert calls == ["extract"]
    assert all(secret not in message for message in error_logs)


@pytest.mark.asyncio
async def test_real_match_failure_stops_optimize_node(monkeypatch):
    calls: list[str] = []

    async def successful_extract(state):
        calls.append("extract")
        state["jd_analyze_results"] = _jd_analysis()
        state["keywords"] = ["Python"]
        return state

    class FailingStructuredModel:
        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            calls.append("match")
            raise ValueError("synthetic match parse failure")

    class FakeModel:
        def with_structured_output(self, schema, method):  # noqa: ARG002
            return FailingStructuredModel()

    async def forbidden_optimize(state):  # noqa: ARG001
        calls.append("optimize")
        raise AssertionError("failed match must stop optimization")

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "jd_extract", successful_extract)
    monkeypatch.setattr(agent, "model", FakeModel())
    monkeypatch.setattr(agent, "keyword_optimize", forbidden_optimize)

    with pytest.raises(RuntimeError, match="resume_match"):
        await agent.run_match("resume", "jd")

    assert calls == ["extract", "match"]


@pytest.mark.asyncio
async def test_run_match_executes_three_nodes_in_order(monkeypatch):
    calls: list[str] = []

    async def successful_extract(state):
        calls.append("extract")
        state["jd_analyze_results"] = _jd_analysis()
        state["keywords"] = ["Python"]
        return state

    async def successful_match(state):
        calls.append("match")
        state["resume_match_results"] = _match_result()
        return state

    async def successful_optimize(state):
        calls.append("optimize")
        state["markdown_content"] = "# optimized"
        return state

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "jd_extract", successful_extract)
    monkeypatch.setattr(agent, "resume_match", successful_match)
    monkeypatch.setattr(agent, "keyword_optimize", successful_optimize)

    result = await agent.run_match("resume", "jd")

    assert calls == ["extract", "match", "optimize"]
    assert result == (
        ["Python"],
        "# optimized",
        _match_result().model_dump(exclude_none=True),
    )
