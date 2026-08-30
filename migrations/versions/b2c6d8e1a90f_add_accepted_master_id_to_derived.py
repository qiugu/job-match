"""add accepted_master_id to derived_resumes

Revision ID: b2c6d8e1a90f
Revises: a1f4c9e7b2d3
Create Date: 2026-08-29

接受匹配结果后，将其落库到 master_resumes（去重复用），
本列记录落库后的 master resume id，标记该结果已被采纳为「我的简历」。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b2c6d8e1a90f"
down_revision = "a1f4c9e7b2d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.add_column(
            sa.Column("accepted_master_id", sa.String(32), nullable=True),
        )


def downgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.drop_column("accepted_master_id")
