"""Feature-gated match pipeline and offline benchmark regression tests."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import app.schemas.agent as agent_schemas
import app.services.agent as agent
import app.services.match_metrics as match_metrics
from app.core.config import Settings
from app.core.prompts import MATCH_ANALYSIS_PROMPT
from app.schemas.agent import JDAnalysis, MatchResult
from app.services.match_metrics import MatchStageError, match_request, match_stage


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = ROOT / "scripts" / "benchmark_match.py"
CASES_PATH = ROOT / "tests" / "fixtures" / "match_latency_cases.json"


def _jd_analysis() -> JDAnalysis:
    return JDAnalysis(
        experiences=["3 年后端经验"],
        hard_skills=["Python", "FastAPI"],
        soft_skills=["沟通"],
        plus=["开源贡献", "Python"],
        rigid=["本科"],
    )


def _match_result() -> MatchResult:
    return MatchResult(
        role="后端工程师",
        score=0.8,
        requirements=[
            {
                "requirement": "熟悉 Python",
                "evidence": "Python / FastAPI",
                "strength": "matched",
                "suggestion": "突出 FastAPI 项目成果",
            },
            {
                "requirement": "熟悉 Kubernetes",
                "evidence": "无",
                "strength": "unspported",
                "suggestion": "保持缺失，不编造经历",
            },
        ],
        summary="事实证据充分，仍有技能缺口。",
    )


def _bundle():
    bundle_type = getattr(agent_schemas, "MatchAnalysisBundle")
    return bundle_type(jd_analysis=_jd_analysis(), match_result=_match_result())


def test_combined_bundle_preserves_match_contract_and_strength_enum():
    assert hasattr(agent_schemas, "MatchAnalysisBundle")
    bundle = _bundle()

    dumped = bundle.match_result.model_dump()
    assert set(dumped) == {"role", "score", "requirements", "summary"}
    assert dumped["requirements"][1]["strength"] == "unspported"

    with pytest.raises(ValidationError):
        agent_schemas.MatchAnalysisBundle(
            jd_analysis=_jd_analysis(),
            match_result={
                "role": "后端工程师",
                "score": 0.8,
                "requirements": [
                    {
                        "requirement": "Python",
                        "evidence": "Python",
                        "strength": "unsupported",
                        "suggestion": "无",
                    }
                ],
                "summary": "ok",
            },
        )


def test_pipeline_setting_defaults_to_legacy_and_rejects_unknown_value():
    assert Settings(_env_file=None).match_pipeline_version == "legacy"
    with pytest.raises(ValidationError):
        Settings(_env_file=None, match_pipeline_version="unknown")


@pytest.mark.asyncio
async def test_legacy_pipeline_calls_three_models_and_keeps_response_contract(
    monkeypatch,
):
    calls: list[str] = []
    jd = _jd_analysis()
    match = _match_result()

    class StageModel:
        def __init__(self, stage: str):
            self.stage = stage

        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            calls.append(self.stage)
            if self.stage == "extract":
                return jd
            if self.stage == "analyze":
                return match
            return SimpleNamespace(content="# optimized", response_metadata={})

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "get_match_llm", lambda stage: StageModel(stage))
    monkeypatch.setattr(agent.settings, "match_pipeline_version", "legacy")

    result = await agent.run_match("resume", "jd")

    assert calls == ["extract", "analyze", "optimize"]
    assert result == (
        ["Python", "FastAPI", "沟通", "开源贡献"],
        "# optimized",
        match.model_dump(exclude_none=True),
    )


@pytest.mark.asyncio
async def test_combined_pipeline_calls_two_models_and_keeps_response_contract(
    monkeypatch,
):
    calls: list[str] = []
    bundle = _bundle()

    class StageModel:
        def __init__(self, stage: str):
            self.stage = stage

        def with_structured_output(self, schema, method):
            assert schema is agent_schemas.MatchAnalysisBundle
            assert method == "json_mode"
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            calls.append(self.stage)
            if self.stage == "analyze":
                return bundle
            return SimpleNamespace(content="# optimized", response_metadata={})

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "get_match_llm", lambda stage: StageModel(stage))
    monkeypatch.setattr(agent.settings, "match_pipeline_version", "combined")

    result = await agent.run_match("resume", "jd")

    assert calls == ["analyze", "optimize"]
    assert result == (
        ["Python", "FastAPI", "沟通", "开源贡献"],
        "# optimized",
        bundle.match_result.model_dump(exclude_none=True),
    )


@pytest.mark.asyncio
async def test_combined_analysis_failure_short_circuits_optimization(monkeypatch):
    calls: list[str] = []

    class StageModel:
        def __init__(self, stage: str):
            self.stage = stage

        def with_structured_output(self, schema, method):  # noqa: ARG002
            return self

        async def ainvoke(self, prompt, config=None):  # noqa: ARG002
            calls.append(self.stage)
            if self.stage == "analyze":
                raise ValueError("synthetic combined failure")
            raise AssertionError("failed combined analysis must stop optimization")

    monkeypatch.setattr(agent, "is_configured", lambda: True)
    monkeypatch.setattr(agent, "get_match_llm", lambda stage: StageModel(stage))
    monkeypatch.setattr(agent.settings, "match_pipeline_version", "combined")

    with pytest.raises(MatchStageError) as caught:
        await agent.run_match("resume", "jd")

    assert caught.value.stage == "analyze_match"
    assert calls == ["analyze"]


def test_combined_prompt_keeps_evidence_limits_and_full_analysis_contract():
    prompt = MATCH_ANALYSIS_PROMPT

    assert "只能根据候选人简历中的事实" in prompt
    assert "不得标记为 matched" in prompt
    assert "requirements 最多 15 条" in prompt
    assert "evidence" in prompt and "不超过 30 字" in prompt
    assert "suggestion" in prompt and "不超过 50 字" in prompt
    for strength in ("matched", "weak", "missing", "unspported"):
        assert strength in prompt
    for field in ("role", "score", "requirements", "summary"):
        assert f'"{field}"' in prompt


def test_stage_metrics_label_the_selected_pipeline(monkeypatch):
    records: list[tuple[str, str]] = []
    monkeypatch.setattr(match_metrics.settings, "match_pipeline_version", "combined")
    monkeypatch.setattr(
        match_metrics.logger,
        "info",
        lambda message, encoded: records.append((message, encoded)),
    )

    with match_request("request-combined"):
        with match_stage("analyze_match", attempt=1, input_chars=10):
            pass

    [payload] = [
        json.loads(encoded)
        for message, encoded in records
        if message == "match_stage %s"
    ]
    assert payload["pipeline_version"] == "combined"
    assert payload["stage"] == "analyze_match"


def _load_benchmark_module():
    assert BENCHMARK_PATH.exists()
    spec = importlib.util.spec_from_file_location("benchmark_match", BENCHMARK_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_benchmark_refuses_to_run_without_explicit_live_flag(
    tmp_path,
    monkeypatch,
):
    benchmark = _load_benchmark_module()
    called = False

    async def forbidden_live_run(args):  # noqa: ARG001
        nonlocal called
        called = True
        raise AssertionError("offline invocation must not run the model")

    monkeypatch.setattr(benchmark, "run_live_benchmark", forbidden_live_run)
    output = tmp_path / "result.json"

    with pytest.raises(SystemExit) as caught:
        benchmark.main(
            [
                "--cases",
                str(CASES_PATH),
                "--pipeline",
                "legacy",
                "--repeats",
                "1",
                "--concurrency",
                "1",
                "--output",
                str(output),
            ]
        )

    assert caught.value.code == 2
    assert called is False
    assert not output.exists()


def test_benchmark_result_record_cannot_contain_resume_jd_or_model_output():
    benchmark = _load_benchmark_module()

    record = benchmark.build_result_record(
        case_id="case-01",
        pipeline="combined",
        repeat=1,
        latency_ms=1234,
        success=True,
        error_type=None,
        input_tokens=100,
        output_tokens=40,
        reasoning_tokens=None,
        quality={
            "analysis_contract_valid": True,
            "requirement_count": 2,
            "optimized_resume_chars": 321,
            "manual_review": "pending",
        },
    )

    assert set(record) == {"case_id", "performance", "tokens", "quality"}
    assert set(record["performance"]) == {
        "pipeline",
        "repeat",
        "latency_ms",
        "success",
        "error_type",
    }
    assert set(record["tokens"]) == {
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "total_tokens",
    }
    encoded = json.dumps(record, ensure_ascii=False).lower()
    for forbidden in (
        "resume_text",
        "jd_text",
        "markdown_content",
        "match_analysis",
        "model_output",
    ):
        assert forbidden not in encoded


def test_benchmark_fixture_keeps_bodies_only_in_controlled_cases_file():
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))

    assert len(cases) >= 3
    assert all(
        set(case) == {"case_id", "resume_text", "jd_text"}
        for case in cases
    )
    assert len({case["case_id"] for case in cases}) == len(cases)
    assert all(
        case["resume_text"].strip() and case["jd_text"].strip()
        for case in cases
    )
