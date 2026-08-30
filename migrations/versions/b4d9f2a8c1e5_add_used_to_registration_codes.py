"""add used flag to registration codes

注册码改为一次性：注册成功后即置 used=True，不可再次用于注册，
防止一个有效码被无限注册新账号（账号农场 / 资源滥用）。

down_revision 接在注册码与额度迁移 a3f8e1c7b4d2 之后。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b4d9f2a8c1e5"
down_revision = "a3f8e1c7b4d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "registration_codes",
        sa.Column(
            "used", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    with op.batch_alter_table("registration_codes") as batch_op:
        batch_op.drop_column("used")
