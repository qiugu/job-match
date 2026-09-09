"""quota 模块测试：积分预扣/归还、耗尽、部分扣减、无限制账号。

consume_credits / refund_credits 内部使用 AsyncSessionLocal，
由 conftest 注入测试用临时 DB，因此需要 async 用例并先落库 User。
"""

import pytest

from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from app.models.user import User
from app.schemas.auth import RegisterRequest
from app.services import quota as quota_service


async def _make_user(session, uid="u1", credits=50, role="user"):
    u = User(
        id=uid,
        username=uid,
        nickname=uid,
        password_hash="x",
        token_version=1,
        role=role,
        credits=credits,
        registered_code="",
    )
    session.add(u)
    await session.commit()
    return u


@pytest.mark.asyncio
async def test_consume_deducts_full_cost(session):
    u = await _make_user(session, credits=10)
    ok = await quota_service.consume_credits(u.id, 5)
    assert ok is True
    await session.refresh(u)
    assert u.credits == 5


@pytest.mark.asyncio
async def test_consume_partial_balance(session):
    # 余额不足以扣满 cost 时扣减 0，返回 False（如 3 < 5）
    u = await _make_user(session, credits=3)
    ok = await quota_service.consume_credits(u.id, 5)
    assert ok is False
    await session.refresh(u)
    assert u.credits == 3  # 不会扣成负数


@pytest.mark.asyncio
async def test_consume_fails_when_exhausted(session):
    u = await _make_user(session, credits=4)
    ok = await quota_service.consume_credits(u.id, 5)
    assert ok is False  # WHERE credits >= 5 不满足，rowcount=0
    await session.refresh(u)
    assert u.credits == 4  # 不会被扣成负数


@pytest.mark.asyncio
async def test_refund_restores_cost(session):
    u = await _make_user(session, credits=10)
    await quota_service.consume_credits(u.id, 5)
    await quota_service.refund_credits(u.id, 5)
    await session.refresh(u)
    assert u.credits == 10


@pytest.mark.asyncio
async def test_unlimited_credits_never_exhausted(session):
    # 管理员账号不消耗积分（业务层应跳过预扣），这里验证负余额账号预扣语义：
    # 负余额时 WHERE credits >= cost 不成立 → consume 返回 False，
    # 业务层据此判定「无限制、放行」。
    u = await _make_user(session, credits=-1, role="admin")
    ok = await quota_service.consume_credits(u.id, 5)
    assert ok is False  # 负余额不预扣
    await session.refresh(u)
    assert u.credits == -1  # 不变


@pytest.mark.asyncio
async def test_refund_does_not_touch_unlimited(session):
    # 归还守卫 credits >= 0：无限账号不会被动 +cost
    u = await _make_user(session, credits=-1, role="admin")
    await quota_service.refund_credits(u.id, 5)
    await session.refresh(u)
    assert u.credits == -1


def test_registration_code_model_fields():
    rc = RegistrationCode(
        code="ABC-123", grant_credits=10, expires_at=None, created_at=utcnow()
    )
    assert rc.code == "ABC-123"
    assert rc.grant_credits == 10
    assert hasattr(rc, "redeemed_count")
    assert hasattr(rc, "last_redeemed_at")


def test_register_request_fields():
    req = RegisterRequest(username="bob", password="Pass#1234", code="ABC")
    assert req.username == "bob"
    assert req.password == "Pass#1234"
    assert req.code == "ABC"
