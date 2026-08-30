"""add users and owner

上线自建账号登录：业务与 AI 接口改为「登录后才能调用」，数据按用户隔离。

背景：AI 能力（润色 / 语法检查 / 简历导入 / 匹配）由后端统一持有 LLM api_key，
接口裸奔等同于把额度公开，因此引入 users 表 + JWT 鉴权。

改动：
1. 新建 users 表（用户名唯一；token_version 用于让登出/改口令后的旧令牌失效）；
2. master_resumes / derived_resumes 增加 user_id 列，历史数据统一挂到不可登录的
   遗留账号 username=legacy 名下（避免新注册用户看到他人数据，也不丢数据）。
   配置 AUTH_BOOTSTRAP_USERNAME / AUTH_BOOTSTRAP_PASSWORD 后，该初始账号会在
   启动时接管这些历史记录（见 app/services/auth_bootstrap.py）；
3. 简历标题唯一性从「全局唯一」改为「用户内唯一」：多用户共存后全局唯一会让
   A 起名撞上 B 的简历，同时也会泄露他人标题。历史数据此前已全局去重，
   落在新索引下仍然唯一，无需额外处理。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "e5b7c1a94d2f"
down_revision = "c7e4a1d9b3f6"
branch_labels = None
depends_on = None

LEGACY_USERNAME = "legacy"
# 不可登录口令占位符：不以 scrypt$ 开头，verify_password 恒为 False
UNUSABLE_PASSWORD = "!"


def upgrade() -> None:
    conn = op.get_bind()
    now = datetime.now(timezone.utc)

    op.create_table(
        "users",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("nickname", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("token_version", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )

    legacy_id = uuid.uuid4().hex
    conn.execute(
        sa.text(
            "INSERT INTO users (id, username, nickname, password_hash, token_version, "
            "is_active, last_login_at, created_at, updated_at) "
            "VALUES (:id, :username, :nickname, :password_hash, :token_version, "
            ":is_active, :last_login_at, :created_at, :updated_at)"
        ),
        {
            "id": legacy_id,
            "username": LEGACY_USERNAME,
            "nickname": "历史数据",
            "password_hash": UNUSABLE_PASSWORD,
            "token_version": 1,
            "is_active": 0,
            "last_login_at": None,
            "created_at": now,
            "updated_at": now,
        },
    )

    for table in ("master_resumes", "derived_resumes"):
        op.add_column(
            table,
            sa.Column(
                "user_id", sa.String(length=32), nullable=False, server_default=""
            ),
        )
        op.create_index(
            f"ix_{table}_user_id", table, ["user_id"], unique=False
        )
        conn.execute(
            sa.text(
                f"UPDATE {table} SET user_id = :uid WHERE user_id IS NULL OR user_id = ''"
            ),
            {"uid": legacy_id},
        )

    # 标题唯一性：全局 → 用户内
    op.drop_index("uq_master_resumes_title", table_name="master_resumes")
    op.create_index(
        "uq_master_resumes_user_title",
        "master_resumes",
        ["user_id", "title"],
        unique=True,
    )


def downgrade() -> None:
    # 降级后标题恢复全局唯一：若多用户存在同名简历，此处会失败，
    # 需先手工处理同名数据（降级路径仅用于回滚到无登录版本，生产极少触发）。
    op.drop_index("uq_master_resumes_user_title", table_name="master_resumes")
    op.create_index("uq_master_resumes_title", "master_resumes", ["title"], unique=True)

    for table in ("master_resumes", "derived_resumes"):
        op.drop_index(f"ix_{table}_user_id", table_name=table)
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_column("user_id")

    op.drop_table("users")
