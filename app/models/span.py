"""一次业务调用（Trace）内中间节点的持久化执行记录（对齐 OTel Span 语义）。

一个 Span = 一个执行单元：匹配的 jd_extract / resume_match / keyword_optimize，
翻译的 translate_fields，JD 图片识别的 jd_image_extract 等。

与旧 ``match_run_step`` 的关系：本表是它的**泛化**——把「匹配专属」的 step 模型
推广到所有 AI 端点，因此新增 ``trace_id``（替代 match_run_id）与 ``parent_span_id``
（预留嵌套），其余字段语义一致。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


class Span(Base):
    __tablename__ = "spans"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # 所属 trace（逻辑外键，不建 FK 约束，对齐 llm_usage.match_run_id 惯例）
    trace_id: Mapped[str] = mapped_column(String(32), index=True)
    # 父 span（预留嵌套；当前多为单层，空=顶层节点）
    parent_span_id: Mapped[str | None] = mapped_column(
        String(32), default=None, nullable=True, index=True
    )
    # 节点标识（jd_extract / resume_match / keyword_optimize / translate / polish / ...）
    step_key: Mapped[str] = mapped_column(String(32), index=True)
    # 节点状态：running / success / error
    status: Mapped[str] = mapped_column(String(16), default="running")
    # 重试次数（第几次尝试，1 起）
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    model: Mapped[str] = mapped_column(String(64), default="")
    error_type: Mapped[str] = mapped_column(String(64), default="")
