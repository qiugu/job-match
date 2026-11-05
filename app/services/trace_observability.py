"""统一可观测性写入服务：把「一次业务调用 → 一串中间节点」落库为 Trace/Span。

对齐 OpenTelemetry 的 Trace/Span 语义（只借概念，不引入 OTel SDK）：

- ``start_trace``：业务端点入口处建立一条 Trace（一次匹配 / 一次翻译 / ...）；
- ``record_span``：记录 Trace 内的一个中间节点（jd_extract / translate / ...）；
- ``finish_trace``：补齐顶层状态、耗时、模型、prompt 版本、错误与摘要。

设计纪律（与 app/services/match_observability.py 一致，但泛化到全端点）：

1. **旁路写入**：所有写入走独立短事务 + 吞异常，观测失败绝不影响业务主流程。
2. **ContextVar 归属**：``trace_context`` 维护当前 trace_id，供 agent 节点内
   ``record_span`` 自动归属（对齐旧 match_run_context）。
3. **隐私红线**：``detail`` 只存字段路径/计数/枚举，绝不存正文；写入前经
   ``usage.serialize_detail`` 统一序列化（8KB 上限、逐级降级）。
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta
from typing import Any, Iterator

from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.core.timeutils import utcnow
from app.models.span import Span
from app.models.trace import Trace
from app.services.usage import serialize_detail

logger = get_logger("trace_observability")

_current_trace_id: ContextVar[str | None] = ContextVar(
    "trace_observability_trace_id", default=None
)


@contextmanager
def trace_context(trace_id: str) -> Iterator[str]:
    """建立当前 trace_id 的上下文，供内部 ``record_span`` 自动归属。

    与旧 ``match_run_context`` 同语义，但命名泛化为 trace。
    """
    token = _current_trace_id.set(trace_id)
    try:
        yield trace_id
    finally:
        _current_trace_id.reset(token)


def get_trace_id() -> str | None:
    return _current_trace_id.get()


async def start_trace(
    user_id: str,
    endpoint: str,
    *,
    context_id: str | None = None,
) -> str:
    """建立一条 Trace（运行中），返回 trace_id。写入失败不影响业务。"""
    import uuid

    trace_id = uuid.uuid4().hex
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                Trace(
                    id=trace_id,
                    user_id=user_id,
                    endpoint=endpoint,
                    status="running",
                    context_id=context_id,
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 观测旁路不能影响业务
        logger.exception(
            "创建 trace 失败 | endpoint=%s user_id=%s", endpoint, user_id
        )
    return trace_id


async def record_span(
    trace_id: str,
    *,
    step_key: str,
    status: str,
    latency_ms: int,
    attempt: int = 1,
    error_type: str = "",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    model: str = "",
    parent_span_id: str | None = None,
) -> str:
    """记录一个中间节点（span），返回 span_id。写入失败不影响业务。

    当 ``trace_id`` 为空串时降级为**自动从上下文取**（agent 节点内常用），
    取不到则仅记日志并跳过——绝不让观测依赖阻断主流程。

    span 只承载节点级状态/耗时/重试/token/错误；端点级结构化摘要（如翻译字段
    统计、JD 图片识别图片数）应通过 ``finish_trace`` 的 ``detail`` 存到 trace 级。
    """
    span_id = _new_id()
    effective_trace_id = trace_id or (get_trace_id() or "")
    if not effective_trace_id:
        logger.warning(
            "record_span 缺少 trace 归属，跳过 | step_key=%s", step_key
        )
        return span_id

    now = utcnow()
    started = now - timedelta(milliseconds=max(0, latency_ms))
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                Span(
                    id=span_id,
                    trace_id=effective_trace_id,
                    parent_span_id=parent_span_id,
                    step_key=step_key,
                    status=status,
                    attempt=attempt,
                    started_at=started,
                    completed_at=now,
                    latency_ms=max(0, latency_ms),
                    error_type=error_type,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    model=model,
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception(
            "写入 span 失败（不影响业务） | trace_id=%s step=%s",
            effective_trace_id,
            step_key,
        )
    return span_id


async def finish_trace(
    trace_id: str,
    *,
    status: str,
    error: BaseException | None = None,
    model: str = "",
    prompt_version: str = "",
    detail: dict[str, Any] | None = None,
    context_id: str | None = None,
) -> None:
    """补齐 Trace 顶层状态。写入失败不影响业务。"""
    completed = utcnow()
    try:
        async with AsyncSessionLocal() as db:
            trace = await db.get(Trace, trace_id)
            if trace is None:
                return
            trace.status = status
            trace.completed_at = completed
            trace.latency_ms = max(
                0, int((completed - trace.started_at).total_seconds() * 1000)
            )
            if model:
                trace.model = model
            if prompt_version:
                trace.prompt_version = prompt_version
            if context_id is not None:
                trace.context_id = context_id
            if detail is not None:
                trace.detail = serialize_detail(detail)
            if error is not None:
                trace.error_type = type(error).__name__
                trace.error_message = str(error)[:1000]
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("完成 trace 失败 | trace_id=%s", trace_id)


def _new_id() -> str:
    import uuid

    return uuid.uuid4().hex
