"""rename derived_resumes.resume_json to markdown_content

衍生简历实际存储的是 Agent 产出的 markdown 文本，字段名 resume_json 易与
结构化 ResumeData JSON 混淆，统一改名为 markdown_content。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "5c1e3f7a2b84"
down_revision = "4b7c2d8e1a90"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite 对列重命名的支持受限，走 batch 模式（重建表）
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.alter_column(
            "resume_json",
            new_column_name="markdown_content",
            existing_type=sa.Text(),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("derived_resumes") as batch_op:
        batch_op.alter_column(
            "markdown_content",
            new_column_name="resume_json",
            existing_type=sa.Text(),
            existing_nullable=False,
        )
