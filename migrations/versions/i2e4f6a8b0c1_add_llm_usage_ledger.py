"""add llm_usage ledger

LLM 用量台账表（Plan.md R1）：一条记录 = 一次业务端点调用（匹配 / 话术 / AI 能力），
把工作流内部多次 LLM 请求汇总成一条，token 累加、耗时取整段。

本表是 R2（AI 限流计费）与 R3（管理员用量统计）的共同数据源，因此必须先于两者落地。

注：Alembic autogenerate 同时报出了 `cover_letters` 的 NOT NULL 差异与
`master_resumes` 的 unique 索引/约束差异——那是既有历史差异，与本次需求无关，
已手工剔除，避免在一次「加表」迁移里夹带不可逆的 ALTER。

downgrade：整表删除（台账可从业务重放，无历史包袱）。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "i2e4f6a8b0c1"
down_revision = "d3e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_usage",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("endpoint", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error_type", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # 主查询路径：某用户某时间窗的用量；端点索引供管理员按功能统计成本
    op.create_index("ix_llm_usage_user_created", "llm_usage", ["user_id", "created_at"])
    op.create_index("ix_llm_usage_endpoint", "llm_usage", ["endpoint"])
    op.create_index("ix_llm_usage_created_at", "llm_usage", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_llm_usage_created_at", table_name="llm_usage")
    op.drop_index("ix_llm_usage_endpoint", table_name="llm_usage")
    op.drop_index("ix_llm_usage_user_created", table_name="llm_usage")
    op.drop_table("llm_usage")
