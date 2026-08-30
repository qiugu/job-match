"""注册码：注册账号必须提供，用于发放「JD 匹配次数」额度。

- 一个码可被兑换的次数不做限制（需求只约束过期时间与授予额度），
   redeemed_count / last_redeemed_at 仅用于审计「发出去的码有没有人用」；
- grant_matches 是用该码注册的账号获得的匹配次数，默认 10；
- 管理员账号不受额度限制（users.match_quota = -1），无需注册码。
"""
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


class RegistrationCode(Base):
    __tablename__ = "registration_codes"
    __table_args__ = (UniqueConstraint("code", name="uq_registration_codes_code"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    code: Mapped[str] = mapped_column(String(64), default="", index=True)
    # 用该码注册的账号获得的匹配次数
    grant_matches: Mapped[int] = mapped_column(Integer, default=10)
    # 过期时间（UTC，naive）；过期后不能用于注册
    expires_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    # 审计字段：被兑换的次数与最后一次兑换时间
    redeemed_count: Mapped[int] = mapped_column(Integer, default=0)
    last_redeemed_at: Mapped[datetime | None] = mapped_column(
        DateTime, default=None, nullable=True
    )
    # 是否已被使用：注册码一次性，注册成功后即置 True，不可再次注册（防注册码滥用）
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
