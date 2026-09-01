"""add registration codes and quota

注册必须携带注册码，注册码发放「JD 匹配次数」额度。

背景：简历匹配会调用 LLM，额度需要可控。注册码是唯一的发放入口——
它决定一个账号能发起多少次匹配（默认 10 次），并有过期时间。

改动：
1. 新建 registration_codes 表：
   - code 唯一，grant_matches=用该码注册的账号获得的匹配次数（默认 10）；
   - expires_at 过期时间，过期后不能用于注册；
   - redeemed_count / last_redeemed_at 仅审计（不做兑换次数上限）；
   - 注册码现由官网自助领取接口发放（POST /api/auth/registration-code）。
2. users 增加 role（user/admin，管理员不受额度限制）、match_quota（剩余匹配
   次数，-1 表示无限制）、registered_code（注册时用的码，审计用）。
3. 存量账号的 match_quota 统一为 -1（沿用升级前的「不限制」），避免升级后
   老账号突然无法匹配；新注册账号一律按注册码额度。需要给老账号设额度时，
   直接 UPDATE users SET match_quota = <次数> 即可。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a3f8e1c7b4d2"
down_revision = "e5b7c1a94d2f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "registration_codes",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("grant_matches", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("redeemed_count", sa.Integer(), nullable=False),
        sa.Column("last_redeemed_at", sa.DateTime(), nullable=True),
        sa.Column("note", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code", name="uq_registration_codes_code"),
    )
    op.create_index(
        "ix_registration_codes_code", "registration_codes", ["code"], unique=False
    )

    op.add_column(
        "users",
        sa.Column("role", sa.String(length=16), nullable=False, server_default="user"),
    )
    op.add_column(
        "users",
        sa.Column("match_quota", sa.Integer(), nullable=False, server_default="-1"),
    )
    op.add_column(
        "users",
        sa.Column(
            "registered_code", sa.String(length=64), nullable=False, server_default=""
        ),
    )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("registered_code")
        batch_op.drop_column("match_quota")
        batch_op.drop_column("role")

    op.drop_index("ix_registration_codes_code", table_name="registration_codes")
    op.drop_table("registration_codes")
