"""add accepted flag to derived_resumes

Revision ID: 4b7c2d8e1a90
Revises: 3f2a1b9c4d5e
Create Date: 2026-08-28

为 derived_resumes 增加 accepted 列，记录用户是否已确认接受匹配结果。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "4b7c2d8e1a90"
down_revision = "3f2a1b9c4d5e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite 不支持直接 ADD COLUMN 带复杂默认值时的某些组合，
    # 但新增可空 Boolean 列 + server_default 是安全的。
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.add_column(
            sa.Column(
                "accepted",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.drop_column("accepted")
