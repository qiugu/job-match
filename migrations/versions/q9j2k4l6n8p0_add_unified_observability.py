"""add unified observability traces and spans

Revision ID: q9j2k4l6n8p0
Revises: p8i0k2l4n6q8

背景（docs/PLAN_unified_observability.md）：把「匹配专属」的 match_runs /
match_run_steps 执行链模型泛化到所有 AI 端点，对齐 OpenTelemetry Trace/Span
语义。新增两张表：

- traces：一次业务调用（匹配/翻译/润色/语法/导入/求职信），记录顶层状态、
  耗时、模型、prompt 版本、错误与端点级摘要（detail）。
- spans：trace 内的中间节点，记录节点状态、耗时、重试、token 与错误类型。

与 llm_usage 分工：llm_usage 是成本台账，traces/spans 是执行链台账，解耦互不依赖。
旧表 match_runs / match_run_steps 保留不删（历史可查），由回填脚本迁移数据后停止写入。

两表均为新表，非破坏性；迁移前须备份 jobmatch.db。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "q9j2k4l6n8p0"
down_revision = "p8i0k2l4n6q8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "traces",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("endpoint", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("prompt_version", sa.String(length=16), nullable=False),
        sa.Column("error_type", sa.String(length=64), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=False),
        sa.Column("context_id", sa.String(length=32), nullable=True),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_traces_user_started", "traces", ["user_id", "started_at"])
    op.create_index("ix_traces_endpoint", "traces", ["endpoint"])
    op.create_index("ix_traces_user_id", "traces", ["user_id"])
    op.create_index("ix_traces_status", "traces", ["status"])
    op.create_index("ix_traces_started_at", "traces", ["started_at"])
    op.create_index("ix_traces_context_id", "traces", ["context_id"])
    op.create_index("ix_traces_created_at", "traces", ["created_at"])

    op.create_table(
        "spans",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("trace_id", sa.String(length=32), nullable=False),
        sa.Column("parent_span_id", sa.String(length=32), nullable=True),
        sa.Column("step_key", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("error_type", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_spans_trace_id", "spans", ["trace_id"])
    op.create_index("ix_spans_parent_span_id", "spans", ["parent_span_id"])
    op.create_index("ix_spans_step_key", "spans", ["step_key"])


def downgrade() -> None:
    op.drop_index("ix_spans_step_key", table_name="spans")
    op.drop_index("ix_spans_parent_span_id", table_name="spans")
    op.drop_index("ix_spans_trace_id", table_name="spans")
    op.drop_table("spans")

    for index_name in (
        "ix_traces_created_at",
        "ix_traces_context_id",
        "ix_traces_started_at",
        "ix_traces_status",
        "ix_traces_user_id",
        "ix_traces_endpoint",
        "ix_traces_user_started",
    ):
        op.drop_index(index_name, table_name="traces")
    op.drop_table("traces")
