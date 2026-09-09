"""decouple cover_letter from derived_resume

话术（JD 话术）从「简历匹配副产物」解耦为独立资源：

1. derived_resume_id 由 NOT NULL 改为可空：匹配顺带生成时仍填充，
   独立生成时为 NULL。
2. 新增归属与溯源字段：user_id（与项目其他 user_id 一致，String(32)
   可空默认空串）、resume_text / jd_text（生成时快照，便于独立刷新）、
   scene（场景，默认 greeting）、model（生成模型，审计用）。
3. 历史话术回填：从关联的 derived_resumes JOIN 回填 user_id / jd_text /
   resume_text；scene 默认 greeting。

SQLite 下 alter_column nullable 与 add_column 经 batch_alter_table 重建表，
FK 约束自动重建。downgrade 仅在本库尚未产生「独立话术」（derived_resume_id
全非空）时安全；若已存在独立话术，会先删除再恢复 NOT NULL。
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision = "f1a2b3c4d5e6"
down_revision = "e0c1d2a3b4f5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("cover_letters") as batch_op:
        batch_op.alter_column(
            "derived_resume_id",
            existing_type=sa.String(length=32),
            nullable=True,
            existing_nullable=False,
        )
        batch_op.add_column(
            sa.Column("user_id", sa.String(length=32), nullable=True, server_default="")
        )
        batch_op.add_column(
            sa.Column("resume_text", sa.Text(), nullable=True, server_default="")
        )
        batch_op.add_column(
            sa.Column("jd_text", sa.Text(), nullable=True, server_default="")
        )
        batch_op.add_column(
            sa.Column(
                "scene", sa.String(length=32), nullable=False, server_default="greeting"
            )
        )
        batch_op.add_column(
            sa.Column("model", sa.String(length=64), nullable=True, server_default="")
        )
        batch_op.create_index("ix_cover_letters_user_id", ["user_id"], unique=False)

    # 回填历史话术（仅有关联衍生简历的记录）
    op.execute(
        text(
            "UPDATE cover_letters SET user_id = ("
            "SELECT user_id FROM derived_resumes "
            "WHERE derived_resumes.id = cover_letters.derived_resume_id"
            ") WHERE derived_resume_id IS NOT NULL"
        )
    )
    op.execute(
        text(
            "UPDATE cover_letters SET jd_text = ("
            "SELECT jd_text FROM derived_resumes "
            "WHERE derived_resumes.id = cover_letters.derived_resume_id"
            ") WHERE derived_resume_id IS NOT NULL"
        )
    )
    op.execute(
        text(
            "UPDATE cover_letters SET resume_text = ("
            "SELECT markdown_content FROM derived_resumes "
            "WHERE derived_resumes.id = cover_letters.derived_resume_id"
            ") WHERE derived_resume_id IS NOT NULL"
        )
    )


def downgrade() -> None:
    # 删除分离后产生的、无衍生简历归属的独立话术（旧 schema 无法承载）
    op.execute(text("DELETE FROM cover_letters WHERE derived_resume_id IS NULL"))

    with op.batch_alter_table("cover_letters") as batch_op:
        batch_op.drop_index("ix_cover_letters_user_id")
        batch_op.drop_column("model")
        batch_op.drop_column("scene")
        batch_op.drop_column("jd_text")
        batch_op.drop_column("resume_text")
        batch_op.drop_column("user_id")
        batch_op.alter_column(
            "derived_resume_id",
            existing_type=sa.String(length=32),
            nullable=False,
            existing_nullable=True,
        )
