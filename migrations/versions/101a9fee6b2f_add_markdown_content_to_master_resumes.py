"""add markdown_content to master_resumes

用于列表卡片缩略图：在主简历表新增 markdown_content 列，存储简历 markdown 预览文本。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '101a9fee6b2f'
down_revision = 'd8d6df3feb9a'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "master_resumes",
        sa.Column("markdown_content", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("master_resumes", "markdown_content")
