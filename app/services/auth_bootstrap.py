"""初始化账号：AUTH_BOOTSTRAP_USERNAME / AUTH_BOOTSTRAP_PASSWORD 的首建与历史数据接管。

背景：登录功能上线前数据库里已有简历数据。迁移会把这些记录挂到一个不可登录的
遗留账号（username=legacy）名下，避免新用户看到/改到别人的数据。若部署者配置了
初始账号，则该账号创建后接管这些历史记录——首次部署登录后仍能看到原有简历，
不会「升级后数据消失」。

未配置初始账号时，任何人都能通过注册接口创建账号，但看不到遗留数据。
"""
from __future__ import annotations

import re

from sqlalchemy import delete, select, update

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.logging import get_logger
from app.core.security import hash_password
from app.core.timeutils import utcnow
from app.models.derived_resume import DerivedResume
from app.models.master_resume import MasterResume
from app.models.user import ROLE_ADMIN, UNLIMITED_QUOTA, User

logger = get_logger("auth.bootstrap")

# 迁移脚本为历史数据创建的占位账号：口令为 "!"（不可登录）
LEGACY_USERNAME = "legacy"
_UNUSABLE_PASSWORD = "!"

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")


async def bootstrap_auth() -> None:
    username = (settings.auth_bootstrap_username or "").strip()
    password = settings.auth_bootstrap_password or ""
    if not username or not password:
        return
    if not _USERNAME_RE.match(username):
        logger.warning(
            "AUTH_BOOTSTRAP_USERNAME 不合法（3-64 位字母数字或 _.-），已跳过初始账号创建"
        )
        return
    if len(password) < 8:
        logger.warning("AUTH_BOOTSTRAP_PASSWORD 少于 8 位，已跳过初始账号创建")
        return

    async with AsyncSessionLocal() as db:
        existing = (
            await db.execute(select(User).where(User.username == username).limit(1))
        ).scalars().first()
        if existing is not None:
            return

        # 初始账号即管理员：匹配额度无限制，也不需要注册码
        user = User(
            username=username,
            nickname=username,
            password_hash=hash_password(password),
            role=ROLE_ADMIN,
            match_quota=UNLIMITED_QUOTA,
            last_login_at=utcnow(),
        )
        db.add(user)
        await db.flush()

        legacy_id = (
            await db.execute(
                select(User.id).where(User.username == LEGACY_USERNAME).limit(1)
            )
        ).scalar_one_or_none()

        # 接管历史数据：无归属的记录 + 遗留账号名下的记录
        for model in (MasterResume, DerivedResume):
            await db.execute(
                update(model)
                .where(
                    (model.user_id == "")
                    | (model.user_id.is_(None))
                    | (model.user_id == legacy_id)
                )
                .values(user_id=user.id)
            )
        if legacy_id:
            await db.execute(delete(User).where(User.id == legacy_id))

        await db.commit()
        logger.info("已创建初始账号「%s」并接管历史数据", username)
