"""LLM 用量台账服务：埋点、写入与聚合查询。

设计要点：

1. **埋点方式**：用 LangChain 官方的 `get_usage_metadata_callback` 收集上下文内的
   token 用量，而不是在每个调用点手工解析返回值。理由：
   - 调用点分散（`agent.py` 多节点工作流、`ai_proxy.py` 流式接口），逐个解析易漏；
   - 该回调基于 contextvar 传播，包在业务入口外层即可覆盖内部所有 LLM 请求，
     新增模型调用时无需改台账代码。
   - 厂商未返回 usage 时得到空字典，此时 token 记 0（不估算、不伪造）。

2. **写入隔离**：与 `app/services/quota.py` 同理，台账走独立短事务。台账是旁路
   数据，写入失败只记日志，绝不向上传播异常——统计少一条可以接受，业务失败不行。

3. **粒度**：一条记录 = 一次业务端点调用（详见 `app/models/llm_usage.py` 的说明）。
"""
from __future__ import annotations

import json
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Iterator
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler, get_usage_metadata_callback
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from sqlalchemy import func, select

from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.models.llm_usage import (
    USAGE_STATUS_ERROR,
    USAGE_STATUS_SUCCESS,
    LlmUsage,
)

logger = get_logger("usage")


@dataclass(frozen=True)
class ModelRunUsage:
    """单个匹配 stage 的模型用量；厂商缺失的字段保留为 ``None``。"""

    input_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    model: str


class RunUsageCallbackHandler(BaseCallbackHandler):
    """按匹配 stage 的逻辑 run_id 聚合模型用量。

    结构化输出 Runnable 可能在外层 run 下创建新的模型 run，因此不能假定配置的
    ``run_id`` 就是 ``on_llm_end`` 收到的 id。这里在模型启动时读取继承的 metadata，
    先把实际模型 run 映射回 stage run，再在结束回调中记录 token。
    """

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._stage_by_model_run: dict[UUID, UUID] = {}
        self._usage_by_stage_run: dict[UUID, ModelRunUsage] = {}

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],  # noqa: ARG002
        messages: list[list[Any]],  # noqa: ARG002
        *,
        run_id: UUID,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,  # noqa: ARG002
    ) -> None:
        stage_run_id = (metadata or {}).get("match_stage_run_id")
        if not stage_run_id:
            return
        try:
            parsed_stage_run_id = UUID(str(stage_run_id))
        except (TypeError, ValueError):
            return
        with self._lock:
            self._stage_by_model_run[run_id] = parsed_stage_run_id

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: UUID,
        **kwargs: Any,  # noqa: ARG002
    ) -> None:
        try:
            generation = response.generations[0][0]
        except IndexError:
            generation = None

        usage_metadata: dict[str, Any] | None = None
        model = ""
        if isinstance(generation, ChatGeneration):
            message = generation.message
            if isinstance(message, AIMessage):
                usage_metadata = message.usage_metadata
                model = str(message.response_metadata.get("model_name") or "")

        with self._lock:
            stage_run_id = self._stage_by_model_run.pop(run_id, run_id)
            if usage_metadata is None:
                return
            details = usage_metadata.get("output_token_details") or {}
            current = ModelRunUsage(
                input_tokens=int(usage_metadata.get("input_tokens") or 0),
                output_tokens=int(usage_metadata.get("output_tokens") or 0),
                reasoning_tokens=(
                    int(details["reasoning"])
                    if details.get("reasoning") is not None
                    else None
                ),
                model=model,
            )
            previous = self._usage_by_stage_run.get(stage_run_id)
            if previous is None:
                self._usage_by_stage_run[stage_run_id] = current
            else:
                self._usage_by_stage_run[stage_run_id] = ModelRunUsage(
                    input_tokens=(previous.input_tokens or 0)
                    + (current.input_tokens or 0),
                    output_tokens=(previous.output_tokens or 0)
                    + (current.output_tokens or 0),
                    reasoning_tokens=(
                        None
                        if previous.reasoning_tokens is None
                        and current.reasoning_tokens is None
                        else (previous.reasoning_tokens or 0)
                        + (current.reasoning_tokens or 0)
                    ),
                    model=previous.model or current.model,
                )

    def on_llm_error(
        self,
        error: BaseException,  # noqa: ARG002
        *,
        run_id: UUID,
        **kwargs: Any,  # noqa: ARG002
    ) -> None:
        with self._lock:
            self._stage_by_model_run.pop(run_id, None)

    def usage_for(self, stage_run_id: UUID) -> ModelRunUsage | None:
        with self._lock:
            return self._usage_by_stage_run.get(stage_run_id)


_run_usage_callback: ContextVar[RunUsageCallbackHandler | None] = ContextVar(
    "match_run_usage_callback",
    default=None,
)


@contextmanager
def use_run_usage_callback(
    callback: RunUsageCallbackHandler,
) -> Iterator[RunUsageCallbackHandler]:
    """在当前异步 task 中暴露 stage 用量回调，退出时可靠复位。"""

    token = _run_usage_callback.set(callback)
    try:
        yield callback
    finally:
        _run_usage_callback.reset(token)


def get_run_usage_callback() -> RunUsageCallbackHandler | None:
    return _run_usage_callback.get()


def _summarize_usage(usage_metadata: dict[str, Any] | None) -> tuple[int, int, int, str]:
    """把回调收集到的 `usage_metadata` 汇总为 (输入, 输出, 合计, 模型名)。

    工作流可能依次用到多个模型，此时 token 累加、模型名取首个（明细靠日志排查）。
    部分厂商不回 `total_tokens`，缺失时用输入+输出补齐。
    """
    prompt = completion = total = 0
    model = ""
    for name, meta in (usage_metadata or {}).items():
        if not model:
            model = str(name)
        prompt += int(meta.get("input_tokens") or 0)
        completion += int(meta.get("output_tokens") or 0)
        total += int(meta.get("total_tokens") or 0)
    if total == 0:
        total = prompt + completion
    return prompt, completion, total, model


@asynccontextmanager
async def track_llm(
    endpoint: str,
    user_id: str = "",
    model: str = "",
    match_run_id: str | None = None,
    prompt_version: str = "",
    detail_ref: dict | None = None,
) -> AsyncIterator[None]:
    """记录一次业务端点调用的 LLM 用量。

    用法：

        async with track_llm(ENDPOINT_MATCH, user_id=user.id):
            result = await run_match(...)

    需要记录端点级诊断摘要时，额外传一个**可变空字典**作为 `detail_ref`，
    在事务体内把统计结果 `update()` 进去，退出时统一落库：

        stats: dict = {}
        async with track_llm(ENDPOINT_AI_TRANSLATE, user_id=user.id, detail_ref=stats):
            translated = await ai_proxy.translate_fields(...)
            stats.update(ai_proxy.summarize_translation(fields, translated))

    之所以用可变容器而不是返回值：统计只有在业务调用**之后**才知道，而台账写入
    发生在 `finally`，容器是唯一能跨越这两个时点的通道，且不给业务函数增加返回值
    负担（`translate_fields` 的签名对既有调用方保持不变）。

    无论内部成功还是抛异常都会落库（异常时 status=error 并保留异常类名），
    随后原样向上抛出，不改变既有错误处理语义。
    """
    started = time.perf_counter()
    status = USAGE_STATUS_SUCCESS
    error_type = ""
    usage_metadata: dict[str, Any] = {}
    run_usage_callback = RunUsageCallbackHandler()
    try:
        # 注意：该回调是**同步**上下文管理器（基于 contextvar 收集），即使在异步
        # 函数中也用 `with`——langchain_core 1.x 未提供 async 版本。
        # contextvar 按 task 隔离，故并发请求间的用量不会串台。
        with (
            get_usage_metadata_callback() as cb,
            use_run_usage_callback(run_usage_callback),
        ):
            try:
                yield
            except BaseException as exc:  # noqa: BLE001 - 记录后原样抛出
                status = USAGE_STATUS_ERROR
                error_type = type(exc).__name__
                raise
            finally:
                # 即使内部抛异常，已产生的 token 成本也要统计（钱已经花了）
                usage_metadata = cb.usage_metadata
    finally:
        latency_ms = int((time.perf_counter() - started) * 1000)
        prompt, completion, total, used_model = _summarize_usage(usage_metadata)
        await record_llm_usage(
            user_id=user_id,
            endpoint=endpoint,
            model=used_model or model,
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=total,
            latency_ms=latency_ms,
            status=status,
            error_type=error_type,
            match_run_id=match_run_id,
            prompt_version=prompt_version,
            detail=serialize_detail(detail_ref),
        )


# detail 列的硬上限：观测页要读它，但台账不该被长简历撑爆（SQLite 行越大越慢）。
_DETAIL_MAX_BYTES = 8 * 1024


def serialize_detail(detail: dict | None) -> str:
    """把端点的结构化摘要序列化为 JSON 文本，超限时逐级降级。

    降级顺序刻意保留「计数」丢弃「明细」：页面最需要的是「几项未变化、哪一类」，
    而不变 key 的全量列表只是辅助。任何一级降级后仍是合法 JSON——页面直接
    `json.loads` 即可，不需要为截断单独写容错分支。
    """
    if not detail:
        return ""
    text = json.dumps(detail, ensure_ascii=False)
    if len(text.encode("utf-8")) <= _DETAIL_MAX_BYTES:
        return text

    # 第一级：丢掉最长的明细列表，保留计数与分组
    trimmed = {k: v for k, v in detail.items() if k != "unchangedKeys"}
    trimmed["truncated"] = True
    text = json.dumps(trimmed, ensure_ascii=False)
    if len(text.encode("utf-8")) <= _DETAIL_MAX_BYTES:
        return text

    # 第二级：兜底骨架，保证「有记录但明细不可用」仍可区分于「无记录」
    return json.dumps({"truncated": True}, ensure_ascii=False)


async def record_llm_usage(
    *,
    user_id: str = "",
    endpoint: str = "",
    model: str = "",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    latency_ms: int = 0,
    status: str = USAGE_STATUS_SUCCESS,
    error_type: str = "",
    match_run_id: str | None = None,
    prompt_version: str = "",
    detail: str = "",
) -> None:
    """写入一条用量记录（独立短事务，失败只记日志）。

    独立事务的原因：调用方往往正持有一个长事务（匹配工作流要跑几分钟），
    若台账复用同一会话，SQLite 的写锁会被长时间占用，阻塞其他请求。
    """
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                LlmUsage(
                    user_id=user_id,
                    endpoint=endpoint,
                    model=model,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    latency_ms=latency_ms,
                    status=status,
                    error_type=error_type,
                    match_run_id=match_run_id,
                    prompt_version=prompt_version,
                    detail=detail,
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - 旁路数据，绝不影响主流程
        logger.exception(
            "写入 LLM 用量台账失败（不影响业务） | endpoint=%s user_id=%s",
            endpoint,
            user_id,
        )
    else:
        logger.info(
            "LLM 用量 | endpoint=%s user=%s model=%s tokens=%s status=%s latency=%sms",
            endpoint,
            user_id,
            model,
            total_tokens,
            status,
            latency_ms,
        )


async def aggregate_usage(
    *,
    user_id: str | None = None,
    endpoint: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    group_by_endpoint: bool = True,
) -> list[dict[str, Any]]:
    """按条件聚合用量，返回 `[{endpoint, calls, prompt_tokens, ...}, ...]`。

    默认按端点分组（管理员要看「钱花在哪个功能上」）；`group_by_endpoint=False`
    时返回单行总计。时间窗缺省为最近 30 天，避免全表扫描式的统计。
    """
    if since is None:
        since = datetime.now(timezone.utc) - timedelta(days=30)
    stmt = select(
        LlmUsage.endpoint,
        func.count(LlmUsage.id),
        func.coalesce(func.sum(LlmUsage.prompt_tokens), 0),
        func.coalesce(func.sum(LlmUsage.completion_tokens), 0),
        func.coalesce(func.sum(LlmUsage.total_tokens), 0),
    ).where(LlmUsage.created_at >= since)
    if user_id is not None:
        stmt = stmt.where(LlmUsage.user_id == user_id)
    if endpoint is not None:
        stmt = stmt.where(LlmUsage.endpoint == endpoint)
    if until is not None:
        stmt = stmt.where(LlmUsage.created_at < until)
    if group_by_endpoint:
        stmt = stmt.group_by(LlmUsage.endpoint)
    stmt = stmt.order_by(func.count(LlmUsage.id).desc())

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(stmt)).all()
    return [
        {
            # 总计模式下不以端点分组，此时该列无意义，统一置 None
            "endpoint": row[0] if group_by_endpoint else None,
            "calls": int(row[1]),
            "prompt_tokens": int(row[2]),
            "completion_tokens": int(row[3]),
            "total_tokens": int(row[4]),
        }
        for row in rows
    ]
