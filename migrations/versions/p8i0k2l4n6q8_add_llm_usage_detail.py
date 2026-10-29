"""add prompt_version and detail to llm_usage

Revision ID: p8i0k2l4n6q8
Revises: f6a8c0e2d4b7

背景（docs/PLAN_ai_observability.md）：翻译的可观测性此前只有一行汇总 + 一条
滚动日志，「哪个字段没译、当时用的是哪版指令」只能靠猜。这里为台账补两列：
- prompt_version：生效 prompt 指纹，用于把行为变化对齐到指令变化；
- detail：端点自定义结构化摘要（JSON），如翻译的字段统计与未变化分组。

两列均带 server_default 空串：SQLite 的 ADD COLUMN 在加非空列时必须给默认值，
既有行会以空串补齐，语义为「该记录产生于观测上线前，无明细」。
"""
from alembic import op
import sqlalchemy as sa

revision = "p8i0k2l4n6q8"
down_revision = "f6a8c0e2d4b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "llm_usage",
        sa.Column("prompt_version", sa.String(length=16), nullable=False, server_default=""),
    )
    op.add_column(
        "llm_usage",
        sa.Column("detail", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("llm_usage", "detail")
    op.drop_column("llm_usage", "prompt_version")
