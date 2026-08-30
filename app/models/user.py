"""用户模型：自建账号体系（用户名 + 口令），登录后才能使用业务与 AI 接口。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return uuid.uuid4().hex


# 无限制的匹配额度：额度字段取负值即表示「不限次数」（管理员默认 -1）
UNLIMITED_QUOTA = -1
ROLE_USER = "user"
ROLE_ADMIN = "admin"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("username", name="uq_users_username"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    username: Mapped[str] = mapped_column(String(64), default="")
    nickname: Mapped[str] = mapped_column(String(64), default="")
    # scrypt 密文（格式见 app/core/security.py）；迁移遗留账号为占位符 "!"
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    # 令牌版本号：登出/改口令时 +1，使此前签发的所有 JWT 失效
    token_version: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # 角色：admin 不受匹配额度限制（初始账号）；user 按额度使用
    role: Mapped[str] = mapped_column(String(16), default=ROLE_USER)
    # 剩余可发起的「简历匹配 JD」次数：-1（及其他负值）表示无限制
    match_quota: Mapped[int] = mapped_column(Integer, default=10)
    # 注册时使用的注册码（审计用；管理员/初始账号为空）
    registered_code: Mapped[str] = mapped_column(String(64), default="")
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime, default=None, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    @property
    def unlimited_match_quota(self) -> bool:
        """管理员与负额度账号都不消耗匹配次数。"""
        return self.is_admin or self.match_quota < 0
