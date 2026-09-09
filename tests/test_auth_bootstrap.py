"""auth_bootstrap 测试：初始账号接管 legacy / 无归属数据。

依据 app/services/auth_bootstrap.py：bootstrap_auth() 在配置了
AUTH_BOOTSTRAP_USERNAME/PASSWORD 时创建管理员账号，并接管
user_id 为空 / None / legacy 名下的 MasterResume 与 DerivedResume，
随后删除 legacy 账号。
"""

import pytest

from app.core.config import settings
from app.core.timeutils import utcnow
from app.models.master_resume import MasterResume
from app.models.user import User
from app.services import auth_bootstrap


@pytest.mark.asyncio
async def test_bootstrap_takes_over_legacy_and_orphan(session, monkeypatch):
    monkeypatch.setattr(settings, "auth_bootstrap_username", "admin")
    monkeypatch.setattr(settings, "auth_bootstrap_password", "Sup3rSecret")

    # 预置 legacy 用户（不可登录）与无归属简历
    legacy = User(
        id="legacy-id",
        username="legacy",
        nickname="legacy",
        password_hash="!",
        token_version=1,
        role="user",
        credits=-1,
        is_active=False,
        registered_code="",
    )
    orphan = MasterResume(
        id="m-orphan",
        user_id="",
        title="Orphan Resume",
        raw_text="raw",
        markdown_content="# md",
    )
    owned = MasterResume(
        id="m-owned",
        user_id="someone-else",
        title="Owned",
        raw_text="raw",
        markdown_content="# md",
    )
    session.add_all([legacy, orphan, owned])
    await session.commit()

    await auth_bootstrap.bootstrap_auth()

    # 初始账号被创建且为 admin + 无限制
    from sqlalchemy import select

    res = await session.execute(
        select(User).where(User.username == "admin").limit(1)
    )
    admin = res.scalars().first()
    assert admin is not None
    assert admin.is_admin is True
    assert admin.unlimited_credits is True

    # 无归属简历被接管
    await session.refresh(orphan)
    assert orphan.user_id == admin.id

    # 归属于他人（非 legacy/空）的简历不被接管
    await session.refresh(owned)
    assert owned.user_id == "someone-else"

    # legacy 账号被删除
    res = await session.execute(
        select(User).where(User.username == "legacy").limit(1)
    )
    assert res.scalars().first() is None


@pytest.mark.asyncio
async def test_bootstrap_idempotent(session, monkeypatch):
    monkeypatch.setattr(settings, "auth_bootstrap_username", "admin2")
    monkeypatch.setattr(settings, "auth_bootstrap_password", "Sup3rSecret")

    await auth_bootstrap.bootstrap_auth()
    await auth_bootstrap.bootstrap_auth()  # 再次调用应跳过（已存在）

    from sqlalchemy import select

    res = await session.execute(
        select(User).where(User.username == "admin2")
    )
    assert len(res.scalars().all()) == 1


@pytest.mark.asyncio
async def test_bootstrap_noop_without_config(session, monkeypatch):
    monkeypatch.setattr(settings, "auth_bootstrap_username", "")
    monkeypatch.setattr(settings, "auth_bootstrap_password", "")
    # 不应创建任何账号
    await auth_bootstrap.bootstrap_auth()
    from sqlalchemy import select

    res = await session.execute(select(User))
    assert res.scalars().first() is None
