"""remove master resume concept

Revision ID: 3f2a1b9c4d5e
Revises: d8d6df3feb9a
Create Date: 2026-08-28

移除「主简历」概念：
- derived_resumes 删除 master_resume_id 列与外键（匹配不再溯源主简历）
- master_resumes 删除 is_master 列
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "3f2a1b9c4d5e"
down_revision = "101a9fee6b2f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite 不支持直接的 ALTER/DROP CONSTRAINT，使用 batch 模式（复制-重建表策略）。
    with op.batch_alter_table("derived_resumes") as batch_op:
        # 删除列时 batch 模式会在复制-重建表过程中自动移除关联外键
        batch_op.drop_column("master_resume_id")
    with op.batch_alter_table("master_resumes") as batch_op:
        batch_op.drop_column("is_master")


def downgrade() -> None:
    with op.batch_alter_table("master_resumes") as batch_op:
        batch_op.add_column(
            sa.Column("is_master", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.add_column(
            sa.Column("master_resume_id", sa.String(32), nullable=True),
        )
        batch_op.create_foreign_key(
            "fk_derived_resumes_master_resume_id_master_resumes",
            "master_resumes",
            ["master_resume_id"],
            ["id"],
        )
