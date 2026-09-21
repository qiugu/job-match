"""匹配阶段结构化日志与模型 run 用量关联测试。"""
from __future__ import annotations

import asyncio
import json

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from sqlalchemy import select

from app.models.llm_usage import ENDPOINT_MATCH, LlmUsage
from app.services.match_metrics import match_request, match_stage
from app.services.usage import (
    RunUsageCallbackHandler,
    track_llm,
    use_run_usage_callback,
)


class _UsageFakeModel(FakeListChatModel):
    """通过真实 Runnable 回调链返回 usage，避免手工调用 callback。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # noqa: ARG002
        message = AIMessage(
            content="ok",
            usage_metadata={
                "input_tokens": 11,
                "output_tokens": 7,
                "total_tokens": 18,
            },
            response_metadata={"model_name": "fake-model"},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


def _payloads(records: list[tuple[str, str]]) -> list[dict]:
    return [
        json.loads(encoded)
        for message, encoded in records
        if message == "match_stage %s"
    ]


@pytest.mark.asyncio
async def test_concurrent_request_ids_do_not_leak(monkeypatch):
    records: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.services.match_metrics.logger.info",
        lambda message, encoded: records.append((message, encoded)),
    )
    both_started = asyncio.Event()
    started = 0

    async def emit(request_id: str):
        nonlocal started
        with match_request(request_id):
            with match_stage("jd_extract", attempt=1, input_chars=2):
                started += 1
                if started == 2:
                    both_started.set()
                await both_started.wait()
                await asyncio.sleep(0)

    await asyncio.gather(emit("request-a"), emit("request-b"))

    payloads = _payloads(records)
    assert {item["request_id"] for item in payloads} == {"request-a", "request-b"}
    assert all(item["stage"] == "jd_extract" for item in payloads)
    assert all(item["status"] == "success" for item in payloads)


def test_failed_stage_is_logged_without_input_or_error_text(monkeypatch):
    records: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.services.match_metrics.logger.info",
        lambda message, encoded: records.append((message, encoded)),
    )
    secret = "PRIVATE RESUME BODY"

    with pytest.raises(RuntimeError, match=secret):
        with match_request("request-failure"):
            with match_stage("resume_match", attempt=1, input_chars=len(secret)):
                raise RuntimeError(secret)

    [payload] = _payloads(records)
    assert payload["request_id"] == "request-failure"
    assert payload["status"] == "error"
    assert payload["error_type"] == "RuntimeError"
    assert payload["duration_ms"] >= 0
    assert payload["input_chars"] == len(secret)
    assert secret not in json.dumps(payload, ensure_ascii=False)


@pytest.mark.asyncio
async def test_model_callback_associates_usage_with_stage_run_id(monkeypatch):
    records: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.services.match_metrics.logger.info",
        lambda message, encoded: records.append((message, encoded)),
    )
    callback = RunUsageCallbackHandler()

    with use_run_usage_callback(callback):
        with match_request("request-usage"):
            with match_stage("jd_extract", attempt=1, input_chars=20) as stage:
                await _UsageFakeModel(responses=["ok"]).ainvoke(
                    "hello",
                    config=stage.runnable_config,
                )

    [payload] = _payloads(records)
    assert payload["input_tokens"] == 11
    assert payload["output_tokens"] == 7
    assert payload["effective_model"] == "fake-model"


@pytest.mark.asyncio
async def test_stage_usage_keeps_single_business_ledger_record(
    session,
    monkeypatch,
):
    records: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.services.match_metrics.logger.info",
        lambda message, encoded: records.append((message, encoded)),
    )

    with match_request("request-ledger"):
        async with track_llm(ENDPOINT_MATCH, user_id="user-1"):
            with match_stage("jd_extract", attempt=1, input_chars=20) as stage:
                await _UsageFakeModel(responses=["ok"]).ainvoke(
                    "hello",
                    config=stage.runnable_config,
                )

    rows = (await session.execute(select(LlmUsage))).scalars().all()
    assert len(rows) == 1
    assert rows[0].endpoint == ENDPOINT_MATCH
    assert rows[0].total_tokens == 18
    [payload] = _payloads(records)
    assert (payload["input_tokens"], payload["output_tokens"]) == (11, 7)


def test_stage_log_keeps_unknown_usage_as_null(monkeypatch):
    records: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.services.match_metrics.logger.info",
        lambda message, encoded: records.append((message, encoded)),
    )

    with match_request("request-no-usage"):
        with match_stage("keyword_optimize", attempt=1, input_chars=5):
            pass

    [payload] = _payloads(records)
    assert payload["input_tokens"] is None
    assert payload["output_tokens"] is None
    assert payload["reasoning_tokens"] is None
