"""cover letter 路由测试：生成/重生成扣 1 积分、耗尽 403、非消耗操作不扣。

依据 app/api/cover_letter.py 的真实契约：
- POST /api/cover-letters 与 POST /{id}/regenerate 为消耗型操作：预扣
  cover_letter_cost（默认 1）积分，成功后响应携带剩余积分 remaining_credits；
- PUT/DELETE/列表/详情不消耗积分，remaining_credits 为 null；
- 余额不足 1 积分 → 403，detail 含「积分」；
- 管理员/无限制账号（credits=-1）不扣，remaining_credits=-1。
通过 monkeypatch 替换 run_cover_letter 注入确定性结果，不触发真实 LLM。
"""

import pytest

from conftest import auth_headers
from app.core.timeutils import utcnow
from app.models.registration_code import RegistrationCode
from sqlalchemy import select


async def _ensure_code(session, code, grant_credits=50):
    res = await session.execute(
        select(RegistrationCode).where(RegistrationCode.code == code)
    )
    if res.scalars().first() is None:
        from datetime import timedelta

        session.add(
            RegistrationCode(
                code=code,
                grant_credits=grant_credits,
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        await session.commit()


async def _login(client, session, username, code, password="Pass#1234"):
    await _ensure_code(session, code)
    r = await client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "code": code},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _fake_run_cover_letter(jd_text, resume_text, scene):
    return "尊敬的招聘经理：\n\n我对贵司岗位非常感兴趣。\n"


@pytest.mark.asyncio
async def test_create_letter_consumes_one_credit(client, session, monkeypatch):
    token = await _login(client, session, "clq1", "CQ1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    r = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# 简历", "jd_text": "# 岗位", "scene": "greeting"},
        headers=h,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"]
    # 初始 50，生成扣 1 → 49
    assert body["remaining_credits"] == 49


@pytest.mark.asyncio
async def test_regenerate_consumes_one_credit(client, session, monkeypatch):
    token = await _login(client, session, "clq2", "CQ2")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    created = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# 简历", "jd_text": "# 岗位", "scene": "greeting"},
        headers=h,
    )
    assert created.status_code == 200, created.text
    cid = created.json()["id"]
    # 生成后 49；重生成再扣 1 → 48
    r = await client.post(f"/api/cover-letters/{cid}/regenerate", json={}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["remaining_credits"] == 48


@pytest.mark.asyncio
async def test_create_letter_exhausted_returns_403(client, session, monkeypatch):
    # 初始仅 1 积分：一次成功生成后余额 0，第二次 → 403
    token = await _login(client, session, "clq3", "CQ3")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    from app.models.user import User

    res = await session.execute(
        select(User).where(User.username == "clq3").limit(1)
    )
    u = res.scalars().first()
    u.credits = 1
    await session.commit()

    r1 = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# r", "jd_text": "# j", "scene": "greeting"},
        headers=h,
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["remaining_credits"] == 0

    r2 = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# r", "jd_text": "# j", "scene": "greeting"},
        headers=h,
    )
    assert r2.status_code == 403, r2.text
    assert "积分" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_non_consuming_ops_do_not_charge(client, session, monkeypatch):
    token = await _login(client, session, "clq4", "CQ4")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    created = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# r", "jd_text": "# j", "scene": "greeting"},
        headers=h,
    )
    cid = created.json()["id"]

    # 列表 / 详情 / 更新：不扣、不带 remaining_credits
    r = await client.get("/api/cover-letters", headers=h)
    assert r.status_code == 200
    for item in r.json():
        assert item["remaining_credits"] is None

    r = await client.get(f"/api/cover-letters/{cid}", headers=h)
    assert r.status_code == 200
    assert r.json()["remaining_credits"] is None

    r = await client.put(
        f"/api/cover-letters/{cid}",
        json={"content": "# 手动编辑后的内容"},
        headers=h,
    )
    assert r.status_code == 200
    assert r.json()["remaining_credits"] is None

    # 余额未被扣减（仍为生成后的 49）
    r = await client.get("/api/auth/me", headers=h)
    assert r.status_code == 200
    assert r.json()["credits"] == 49

    # 删除不扣
    r = await client.delete(f"/api/cover-letters/{cid}", headers=h)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_admin_not_charged_returns_minus_one(client, session, monkeypatch):
    from app.models.user import User

    token = await _login(client, session, "clad", "CAD1")
    h = auth_headers(token)
    monkeypatch.setattr("app.api.cover_letter.run_cover_letter", _fake_run_cover_letter)

    res = await session.execute(select(User).where(User.username == "clad").limit(1))
    u = res.scalars().first()
    u.role = "admin"
    u.credits = -1
    await session.commit()

    r = await client.post(
        "/api/cover-letters",
        json={"resume_text": "# r", "jd_text": "# j", "scene": "greeting"},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert r.json()["remaining_credits"] == -1
