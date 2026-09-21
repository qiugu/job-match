"""简历匹配请求与模型 stage 的结构化可观测性。"""
from __future__ import annotations

import json
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterator
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from app.core.config import settings
from app.core.logging import get_logger
from app.services.usage import RunUsageCallbackHandler, get_run_usage_callback

logger = get_logger("match_metrics")

_request_id: ContextVar[str | None] = ContextVar("match_request_id", default=None)


class MatchStageError(RuntimeError):
    """携带失败节点名的匹配流程异常。"""

    def __init__(self, stage: str, cause: BaseException) -> None:
        self.stage = stage
        self.cause = cause
        super().__init__(f"{stage} 阶段失败：{cause}")


@dataclass(frozen=True)
class MatchStageScope:
    """单个 stage 的逻辑 run 与传给 LangChain Runnable 的配置。"""

    run_id: UUID
    runnable_config: dict[str, Any]


@contextmanager
def match_request(request_id: str | None = None) -> Iterator[str]:
    """建立请求关联 ID；嵌套调用沿用外层 ID，避免日志串台。"""

    current = _request_id.get()
    if current is not None:
        yield current
        return

    assigned = request_id or uuid.uuid4().hex
    token = _request_id.set(assigned)
    try:
        yield assigned
    finally:
        _request_id.reset(token)


@contextmanager
def match_stage(
    stage: str,
    *,
    attempt: int,
    input_chars: int,
) -> Iterator[MatchStageScope]:
    """测量 stage，并在成功、失败或取消时统一输出无正文的 JSON 日志。"""

    request_id = _request_id.get() or uuid.uuid4().hex
    stage_run_id = uuid.uuid4()
    usage_callback: RunUsageCallbackHandler | None = get_run_usage_callback()
    callbacks: list[BaseCallbackHandler] = []
    if usage_callback is not None:
        callbacks.append(usage_callback)
    runnable_config: dict[str, Any] = {
        "run_id": stage_run_id,
        "metadata": {
            "match_request_id": request_id,
            "match_stage": stage,
            "match_stage_run_id": str(stage_run_id),
        },
    }
    if callbacks:
        runnable_config["callbacks"] = callbacks

    started = time.perf_counter()
    status = "success"
    error_type: str | None = None
    try:
        yield MatchStageScope(run_id=stage_run_id, runnable_config=runnable_config)
    except BaseException as exc:  # noqa: BLE001 - 记录后原样传播
        status = "error"
        error_type = type(exc).__name__
        raise
    finally:
        usage = usage_callback.usage_for(stage_run_id) if usage_callback else None
        payload = {
            "request_id": request_id,
            "pipeline_version": settings.match_pipeline_version,
            "stage": stage,
            "attempt": attempt,
            "effective_model": (
                usage.model if usage and usage.model else settings.llm_model
            ),
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "status": status,
            "input_chars": input_chars,
            "input_tokens": usage.input_tokens if usage else None,
            "output_tokens": usage.output_tokens if usage else None,
            "error_type": error_type,
            "ttft_ms": None,
            "reasoning_tokens": usage.reasoning_tokens if usage else None,
            "provider_retry_count": None,
        }
        logger.info("match_stage %s", json.dumps(payload, ensure_ascii=False))
