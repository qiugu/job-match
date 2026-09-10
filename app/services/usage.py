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

import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

from langchain_core.callbacks import get_usage_metadata_callback
from sqlalchemy import func, select

from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.models.llm_usage import (
    USAGE_STATUS_ERROR,
    USAGE_STATUS_SUCCESS,
    LlmUsage,
)

logger = get_logger("usage")


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
) -> AsyncIterator[None]:
    """记录一次业务端点调用的 LLM 用量。

    用法：

        async with track_llm(ENDPOINT_MATCH, user_id=user.id):
            result = await run_match(...)

    无论内部成功还是抛异常都会落库（异常时 status=error 并保留异常类名），
    随后原样向上抛出，不改变既有错误处理语义。
    """
    started = time.perf_counter()
    status = USAGE_STATUS_SUCCESS
    error_type = ""
    usage_metadata: dict[str, Any] = {}
    try:
        # 注意：该回调是**同步**上下文管理器（基于 contextvar 收集），即使在异步
        # 函数中也用 `with`——langchain_core 1.x 未提供 async 版本。
        # contextvar 按 task 隔离，故并发请求间的用量不会串台。
        with get_usage_metadata_callback() as cb:
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
        )


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
