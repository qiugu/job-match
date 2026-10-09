"""auth 路由测试：注册/登录/鉴权/注册码/积分/口令失效。

依据 app/api/auth.py 的真实契约：
- 注册必须带 code；无效/已用/过期返回 400，detail 为可读提示（非 error 字段）。
- 注册码一次性（用即失效）。
- 响应体 AuthResponse：{ token, tokenType, expiresIn, user{credits,...} }。
- 登录失败 401；登出 / 改口令递增 token_version 使旧令牌失效。
"""

import pytest

from conftest import auth_headers
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from app.core.config import settings
from sqlalchemy import select


async def _ensure_code(session, code, grant_credits=50):
    res = await session.execute(
        select(RegistrationCode).where(RegistrationCode.code == code)
    )
    if res.scalars().first() is None:
        # 用未来过期时间（naive，与 utcnow 口径一致）
        from datetime import timedelta

        session.add(
            RegistrationCode(
                code=code,
                grant_credits=grant_credits,
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        await session.commit()


async def _register(client, session, username, code="CODE1", password="Pass#1234"):
    await _ensure_code(session, code)
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "code": code},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.mark.asyncio
async def test_register_with_invalid_code(client, session):
    r = await client.post(
        "/api/auth/register",
        json={"username": "bob", "password": "Pass#1234", "code": "NOPE"},
    )
    assert r.status_code == 400
    assert "注册码" in r.json()["detail"]


@pytest.mark.asyncio
async def test_register_success_grants_credits(client, session):
    token = await _register(client, session, "bob", code="GOOD1", password="Pass#1234")
    # 通过 /me 验证积分（注册码默认 50）
    r = await client.get("/api/auth/me", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json()["credits"] == 50
    assert r.json()["username"] == "bob"


@pytest.mark.asyncio
async def test_register_without_code_grants_default_credits(client):
    """主注册流程无码可用，并按积分模型发放默认试用余额。"""
    r = await client.post(
        "/api/auth/register",
        json={"username": "trialuser", "password": "Pass#1234"},
    )

    assert r.status_code == 200, r.text
    assert r.json()["user"]["credits"] == settings.registration_default_credits


@pytest.mark.asyncio
async def test_register_weak_password(client, session):
    await _ensure_code(session, "WEAK1")
    r = await client.post(
        "/api/auth/register",
        json={"username": "weak", "password": "123", "code": "WEAK1"},
    )
    assert r.status_code == 400
    assert "密码" in r.json()["detail"]


@pytest.mark.asyncio
async def test_register_code_is_one_time(client, session):
    await _ensure_code(session, "ONCE1")
    r1 = await client.post(
        "/api/auth/register",
        json={"username": "user1", "password": "Pass#1234", "code": "ONCE1"},
    )
    assert r1.status_code == 200
    # 再用同一码注册 → 已被使用
    r2 = await client.post(
        "/api/auth/register",
        json={"username": "user2", "password": "Pass#1234", "code": "ONCE1"},
    )
    assert r2.status_code == 400
    assert "已被使用" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_login_and_protected(client, session):
    await _register(client, session, "loginuser", code="LOGIN1")

    # 未带 token → 受保护路由 401
    r = await client.get("/api/master-resumes")
    assert r.status_code == 401

    r = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "Pass#1234"},
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    assert token

    r = await client.get("/api/master-resumes", headers=auth_headers(token))
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_login_wrong_password(client, session):
    await _register(client, session, "usrx", code="LW1")
    r = await client.post(
        "/api/auth/login", json={"username": "usrx", "password": "wrong"}
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_logout_invalidates_token(client, session):
    token = await _register(client, session, "loginu", code="LO1")

    r = await client.post("/api/auth/logout", headers=auth_headers(token))
    assert r.status_code == 200

    r = await client.get("/api/master-resumes", headers=auth_headers(token))
    assert r.status_code == 401  # token_version 递增 → 旧令牌失效


@pytest.mark.asyncio
async def test_change_password_invalidates_old_token(client, session):
    token = await _register(client, session, "chgpw", code="CP1")

    r = await client.post(
        "/api/auth/change-password",
        headers=auth_headers(token),
        json={"oldPassword": "Pass#1234", "newPassword": "NewPass#5678"},
    )
    assert r.status_code == 200

    # 旧 token 失效
    r = await client.get("/api/master-resumes", headers=auth_headers(token))
    assert r.status_code == 401

    # 新口令可登录
    r = await client.post(
        "/api/auth/login",
        json={"username": "chgpw", "password": "NewPass#5678"},
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_change_password_returns_usable_token(client, session):
    """改密响应回发的新令牌必须可直接访问受保护路由。

    前端改密后会把这个令牌落地以保持当前会话登录（useAuthStore.changePassword）。
    若回发的令牌不可用、或前端没有落地它，改密成功后的每个业务请求都会 401——
    这条断言锁住的就是这个契约。
    """
    token = await _register(client, session, "chgpw2", code="CP2")

    r = await client.post(
        "/api/auth/change-password",
        headers=auth_headers(token),
        json={"oldPassword": "Pass#1234", "newPassword": "NewPass#5678"},
    )
    assert r.status_code == 200
    new_token = r.json()["token"]
    assert new_token and new_token != token

    # 新令牌立即可用：当前会话无需重新登录
    r = await client.get("/api/auth/me", headers=auth_headers(new_token))
    assert r.status_code == 200
    assert r.json()["username"] == "chgpw2"


@pytest.mark.asyncio
async def test_change_password_wrong_old_password(client, session):
    token = await _register(client, session, "chgpw3", code="CP3")

    r = await client.post(
        "/api/auth/change-password",
        headers=auth_headers(token),
        json={"oldPassword": "Wrong#1234", "newPassword": "NewPass#5678"},
    )
    assert r.status_code == 400
    assert "原密码" in r.json()["detail"]

    # 原密码校验失败时口令未被改动，旧令牌仍然有效
    r = await client.get("/api/auth/me", headers=auth_headers(token))
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_change_password_weak_new_password(client, session):
    token = await _register(client, session, "chgpw4", code="CP4")

    r = await client.post(
        "/api/auth/change-password",
        headers=auth_headers(token),
        json={"oldPassword": "Pass#1234", "newPassword": "123"},
    )
    assert r.status_code == 400
    assert "密码" in r.json()["detail"]
