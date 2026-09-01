"""drop match_mode from derived_resumes

删除 refactor_mode / match_mode 概念后，衍生简历不再需要 match_mode 列
（匹配方式统一为 optimize，无需持久化）。该列从 derived_resumes 表移除。

down_revision 接在注册码一次性迁移 b4d9f2a8c1e5 之后（当前 head）。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "e0c1d2a3b4f5"
down_revision = "b4d9f2a8c1e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.drop_column("match_mode")


def downgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.add_column(
            sa.Column("match_mode", sa.String(length=32), nullable=False, server_default="optimize")
        )
