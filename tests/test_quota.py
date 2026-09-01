"""quota 模块测试：额度预扣/归还、耗尽、无限制账号。

reserve_match_quota / refund_match_quota 内部使用 AsyncSessionLocal，
由 conftest 注入测试用临时 DB，因此需要 async 用例并先落库 User。
"""

import pytest

from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from app.models.user import User
from app.schemas.auth import RegisterRequest
from app.services import quota as quota_service


async def _make_user(session, uid="u1", match_quota=3, role="user"):
    u = User(
        id=uid,
        username=uid,
        nickname=uid,
        password_hash="x",
        token_version=1,
        role=role,
        match_quota=match_quota,
        registered_code="",
    )
    session.add(u)
    await session.commit()
    return u


@pytest.mark.asyncio
async def test_reserve_consumes_quota(session):
    u = await _make_user(session, match_quota=3)
    ok = await quota_service.reserve_match_quota(u.id)
    assert ok is True
    await session.refresh(u)
    assert u.match_quota == 2


@pytest.mark.asyncio
async def test_reserve_fails_when_exhausted(session):
    u = await _make_user(session, match_quota=0)
    ok = await quota_service.reserve_match_quota(u.id)
    assert ok is False  # WHERE match_quota > 0 不满足，rowcount=0
    await session.refresh(u)
    assert u.match_quota == 0  # 不会被扣成负数


@pytest.mark.asyncio
async def test_refund_restores_quota(session):
    u = await _make_user(session, match_quota=2)
    await quota_service.reserve_match_quota(u.id)
    await quota_service.refund_match_quota(u.id)
    await session.refresh(u)
    assert u.match_quota == 2


@pytest.mark.asyncio
async def test_unlimited_quota_never_exhausted(session):
    # 管理员账号不被额度限制（业务层应跳过预扣），这里验证负额度账号预扣语义：
    # 负额度时 WHERE match_quota > 0 不成立 → reserve 返回 False，
    # 业务层据此判定「无限制、放行」。
    u = await _make_user(session, match_quota=-1, role="admin")
    ok = await quota_service.reserve_match_quota(u.id)
    assert ok is False  # 负额度不预扣
    await session.refresh(u)
    assert u.match_quota == -1  # 不变


def test_registration_code_model_fields():
    rc = RegistrationCode(
        code="ABC-123", grant_matches=10, expires_at=None, created_at=utcnow()
    )
    assert rc.code == "ABC-123"
    assert rc.grant_matches == 10
    assert hasattr(rc, "redeemed_count")
    assert hasattr(rc, "last_redeemed_at")


def test_register_request_fields():
    req = RegisterRequest(username="bob", password="Pass#1234", code="ABC")
    assert req.username == "bob"
    assert req.password == "Pass#1234"
    assert req.code == "ABC"
