"""LLM 用量台账：每一次「业务级」大模型调用的成本留痕。

粒度说明：一条记录 = 一次业务端点调用（匹配 / 话术生成 / AI 润色等），
而不是一次 HTTP 请求到厂商。像简历匹配这种多节点工作流内部会发起多次
LLM 请求，本表把它们汇总成一条记录（token 累加、耗时取整段），理由是
成本归因与限流的口径都应该对齐「用户做了什么」，而不是「我们调了几次」。

用途（Plan.md R1，是 R2 限流与 R3 管理员后台的共同数据源）：
- 成本观测：按用户 / 端点 / 日期聚合 token 与调用次数；
- 限流依据：R2 可直接按 (user_id, endpoint, 时间窗) 计数；
- 异常定位：status=error 时保留 error_type，配合日志回溯。

写入策略与 app/services/quota.py 一致：**独立短事务**。台账写入失败的
后果只是少一条统计，绝不能让业务请求失败，因此由 usage 服务吞掉异常。

双重定位（2026-10-29 追加）：本表既是**成本台账**，也是**端点的诊断入口**。
`prompt_version` 与 `detail` 两列让「这次调用到底做了什么」可被页面上读取，
而不是沉在滚动日志里。`detail` 的内容边界由各端点自行约定，但必须遵守
「只存路径/计数/枚举，不存用户正文」的红线。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


# 调用状态：成功 / 失败（失败也要留痕，否则成本被低估）
USAGE_STATUS_SUCCESS = "success"
USAGE_STATUS_ERROR = "error"

# 业务端点标识：写入前用常量，避免各调用点拼错字符串导致聚合口径不一致
ENDPOINT_MATCH = "match"
ENDPOINT_COVER_LETTER = "cover_letter"
ENDPOINT_AI_POLISH = "ai.polish"
ENDPOINT_AI_GRAMMAR = "ai.grammar"
ENDPOINT_AI_RESUME_IMPORT = "ai.resume_import"
ENDPOINT_AI_TRANSLATE = "ai.translate"


class LlmUsage(Base):
    __tablename__ = "llm_usage"
    # 主查询路径是「某用户在某时间窗内的用量」，故建联合索引；
    # 端点维度单独索引，供管理员按功能统计成本。
    __table_args__ = (
        Index("ix_llm_usage_user_created", "user_id", "created_at"),
        Index("ix_llm_usage_endpoint", "endpoint"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 归属用户；空串表示未登录或无法归因的系统调用
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 业务端点（见 ENDPOINT_* 常量）
    endpoint: Mapped[str] = mapped_column(String(32), default="")
    # 可选的简历匹配运行关联；其他 AI 端点保持为空。
    match_run_id: Mapped[str | None] = mapped_column(
        String(32), default=None, nullable=True, index=True
    )
    # 实际使用的模型名（工作流内多模型时取首个，明细见日志）
    model: Mapped[str] = mapped_column(String(64), default="")
    # token 用量：厂商未返回 usage 时记 0（不伪造、不估算）
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    # 整段业务调用耗时（毫秒）
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    # 状态：success / error（见 USAGE_STATUS_*）
    status: Mapped[str] = mapped_column(String(16), default=USAGE_STATUS_SUCCESS)
    # 失败时的异常类名，便于分类统计（超时 / 解析失败 / 厂商错误等）
    error_type: Mapped[str] = mapped_column(String(64), default="")
    # 生效 prompt 的指纹（sha256 前 8 位）。策略写在 prompt 字符串里，只有记住
    # 版本，才能把「行为变了」对齐到「指令变了」，否则排查只能靠猜。
    prompt_version: Mapped[str] = mapped_column(String(16), default="")
    # 端点自定义的结构化摘要（JSON 文本，写入前由 usage 服务截断到 8KB）。
    # 如翻译的字段总数/译出数/未变化分组/未变化 key 列表。
    # 红线：只允许存字段路径与计数，绝不存简历正文（与日志口径一致）。
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, index=True
    )
