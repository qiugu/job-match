"""rename quota columns to credits and reset existing non-admin balances to 50

匹配额度 → 积分（credits）体系迁移，三道改动：

1. users.match_quota → users.credits：
   - 语义由「剩余匹配次数（每次动作扣 1）」改为「剩余积分（简历匹配扣 5、
     话术生成扣 1）」；
   - 存量非 admin 账号余额统一重置为 50（决策：无付费、注册码免费发放，
     统一新口径）；admin（-1，无限制）保留不动；
   - server_default 由 '-1' 改为 '50'（与 ORM 列默认一致）。
2. registration_codes.grant_matches → registration_codes.grant_credits：
   - 注册码面额语义改为「积分」；存量/未用码的值保留不折算（按新语义解释）。

downgrade：仅反向改列名 + server_default。存量余额已被重置覆盖，无法无损还原，
如需回滚请用迁移前备份的 jobmatch.db。
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy import text

from alembic import op

revision = "d3e5f6a7b8c9"
down_revision = "h2c4d6e8a0f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # 1) 存量非 admin 用户统一重置为 50（admin / 其他负值无限制账号不动）
    conn.execute(text("UPDATE users SET match_quota = 50 WHERE role <> 'admin'"))
    # 2) users.match_quota → users.credits（SQLite batch 重建）
    #    显式传 existing_server_default，否则重建时无法丢弃旧默认 '-1'
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column(
            "match_quota",
            new_column_name="credits",
            existing_type=sa.Integer(),
            existing_nullable=False,
            existing_server_default="-1",
            server_default="50",
        )
    # 3) registration_codes.grant_matches → grant_credits（值保留）
    with op.batch_alter_table("registration_codes") as batch_op:
        batch_op.alter_column(
            "grant_matches",
            new_column_name="grant_credits",
            existing_type=sa.Integer(),
            existing_nullable=False,
        )


def downgrade() -> None:
    # 存量余额已重置（无法无损还原），此处仅反向改列名
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column(
            "credits",
            new_column_name="match_quota",
            existing_type=sa.Integer(),
            existing_nullable=False,
            existing_server_default="50",
            server_default="-1",
        )
    with op.batch_alter_table("registration_codes") as batch_op:
        batch_op.alter_column(
            "grant_credits",
            new_column_name="grant_matches",
            existing_type=sa.Integer(),
            existing_nullable=False,
        )
