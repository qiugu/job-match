"""一次业务调用的统一可观测性追踪记录（对齐 OpenTelemetry Trace 语义）。

一次 Trace = 一次「业务端点」调用（匹配 / 翻译 / 润色 / 语法检查 / 简历导入 /
求职信生成等）。内部子步骤由 ``spans`` 表承载（见 app/models/span.py）。

设计要点（docs/PLAN_unified_observability.md）：

1. **语义对齐 OTel，但不引入 OTel SDK**：借用 Trace/Span 的「一次调用 → 一串
   子步骤」概念，字段命名与 OTel 的 status / start / end 对齐，避免未来迁移成本。
2. **与 ``llm_usage`` 分工**：``llm_usage`` 是**成本台账**（token 累加、限流依据），
   本表是**执行链台账**（节点状态、耗时、重试、错误归因）。两者解耦、互不依赖。
3. **隐私红线**：``detail`` 只存字段路径/计数/枚举，绝不存简历正文或 JD 原文；
   与 ``llm_usage.detail`` 同一口径（复用 usage.serialize_detail 的 8KB 上限）。
4. **旁路写入**：写入失败只记日志，绝不影响业务主流程（与 match_observability
   既有纪律一致）。
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


class Trace(Base):
    __tablename__ = "traces"

    # 主查询路径是「某用户在某时间窗内的调用」，故建联合索引；
    # 单列索引（user_id / endpoint / status / started_at / context_id / created_at）
    # 由各字段的 index=True 自动生成，此处只声明联合索引避免重名冲突。
    __table_args__ = (
        Index("ix_traces_user_started", "user_id", "started_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 归属用户；空串表示未登录或无法归因的系统调用
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 业务端点（复用 app.models.llm_usage.ENDPOINT_* 常量）
    endpoint: Mapped[str] = mapped_column(String(32), default="", index=True)
    # 运行状态：running / success / error
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    # 生效模型（工作流内多模型时取首个，明细见 spans）
    model: Mapped[str] = mapped_column(String(64), default="")
    # 生效 prompt 指纹（sha256 前 8 位），对齐 llm_usage.prompt_version
    prompt_version: Mapped[str] = mapped_column(String(16), default="")
    # 顶层失败异常类名（超时 / 解析失败 / 厂商错误等）
    error_type: Mapped[str] = mapped_column(String(64), default="")
    # 脱敏后的顶层错误信息（截断，不含正文）
    error_message: Mapped[str] = mapped_column(Text, default="")
    # 业务上下文弱关联（匹配→job_id、翻译→resume_id 等），便于反查
    context_id: Mapped[str | None] = mapped_column(
        String(32), default=None, nullable=True, index=True
    )
    # 端点级结构化摘要（JSON 文本），只存路径/计数/枚举
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
