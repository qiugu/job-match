"""系统管理统计：权限、PV/UV 口径、路径归一、限流与时区日界。

回归重点：旧实现把「(天, 访客, 路径) 去重行数」当 PV、把「每日 UV 求和」
当区间 UV，两者均错误；新增用例锁定修正后的语义。
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.api import admin as admin_module
from app.core.security import hash_password
from app.core.timeutils import utcnow
from app.models.derived_resume import DerivedResume
from app.models.job import Job
from app.models.master_resume import MasterResume
from app.models.site_visit_event import SiteVisitEvent
from app.models.user import ROLE_ADMIN, ROLE_USER, User
from conftest import auth_headers


async def _user(session, username: str, role: str) -> User:
    user = User(
        username=username,
        nickname=username,
        password_hash=hash_password("Pass#1234"),
        token_version=1,
        role=role,
        credits=50,
        last_login_at=utcnow(),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def _token(client, username: str) -> str:
    response = await client.post(
        "/api/auth/login",
        json={"username": username, "password": "Pass#1234"},
    )
    assert response.status_code == 200, response.text
    return response.json()["token"]


async def _visit(client, path: str, visitor: str = "visitor-a") -> object:
    return await client.post(
        "/api/site-visits", json={"path": path, "visitorId": visitor}
    )


async def _dashboard(client, token: str, query: str = "days=7") -> object:
    return await client.get(
        f"/api/admin/dashboard?{query}", headers=auth_headers(token)
    )


@pytest.mark.asyncio
async def test_admin_dashboard_requires_admin(client, session):
    response = await client.get("/api/admin/dashboard")
    assert response.status_code == 401

    await _user(session, "normal-user", ROLE_USER)
    token = await _token(client, "normal-user")
    response = await client.get(
        "/api/admin/dashboard", headers=auth_headers(token)
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_admin_dashboard_counts_real_pv_and_deduplicates_uv(client, session):
    """同访客重复浏览同路径应照常累加 PV，UV 仍按访客去重。"""
    admin = await _user(session, "admin", ROLE_ADMIN)
    member = await _user(session, "member", ROLE_USER)
    session.add_all(
        [
            MasterResume(user_id=member.id, title="Resume"),
            DerivedResume(user_id=member.id, title="Match"),
            Job(user_id=member.id, title="Engineer", jd_text="JD"),
        ]
    )
    await session.commit()

    for path, visitor in [
        ("/", "visitor-a"),
        ("/", "visitor-a"),
        ("/login", "visitor-a"),
        ("/", "visitor-b"),
    ]:
        response = await _visit(client, path, visitor)
        assert response.status_code == 204, response.text

    token = await _token(client, admin.username)
    response = await _dashboard(client, token)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["range"] == 7
    assert body["tzOffset"] == 480
    assert body["overview"]["users"] == 2
    assert body["overview"]["masterResumes"] == 1
    assert body["overview"]["derivedResumes"] == 1
    assert body["overview"]["jobs"] == 1
    assert len(body["daily"]) == 7
    assert body["overview"]["totalPv"] == 4
    assert sum(item["pv"] for item in body["daily"]) == 4
    assert body["overview"]["uniqueVisitors"] == 2
    assert sum(item["uv"] for item in body["daily"]) == 2

    events = (await session.execute(select(SiteVisitEvent))).scalars().all()
    assert len(events) == 4  # 每次浏览落一行，不再被唯一约束吞掉


@pytest.mark.asyncio
async def test_range_unique_visitors_are_not_summed_daily(client, session):
    """同一访客跨天访问：日 UV 之和为 2，区间 UV 必须为 1。"""
    admin = await _user(session, "admin", ROLE_ADMIN)
    now = utcnow()
    session.add_all(
        [
            SiteVisitEvent(visitor_hash="same", path="/", occurred_at=now),
            SiteVisitEvent(
                visitor_hash="same", path="/", occurred_at=now - timedelta(days=1)
            ),
        ]
    )
    await session.commit()

    token = await _token(client, admin.username)
    response = await _dashboard(client, token)
    assert response.status_code == 200, response.text
    body = response.json()
    assert sum(item["uv"] for item in body["daily"]) == 2
    assert body["overview"]["uniqueVisitors"] == 1
    assert body["overview"]["totalPv"] == 2


@pytest.mark.asyncio
async def test_visit_paths_are_normalized(client, session):
    for path in [
        "/zh/app/dashboard",
        "/app/dashboard?from=home",
        "/app/workbench/2a0d21e84a414aaf80943e75d753ad87",
    ]:
        response = await _visit(client, path)
        assert response.status_code == 204, response.text
    paths = set((await session.execute(select(SiteVisitEvent.path))).scalars().all())
    assert paths == {"/app/dashboard", "/app/workbench/:id"}


@pytest.mark.asyncio
async def test_site_visit_rate_limit(client):
    admin_module.site_visit_limiter.reset()
    for _ in range(admin_module.site_visit_limiter.max_hits):
        response = await _visit(client, "/")
        assert response.status_code == 204, response.text
    response = await _visit(client, "/")
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 1


@pytest.mark.asyncio
async def test_site_visit_rate_limit_cannot_be_bypassed_by_rotating_visitor_id(client):
    """限流必须按客户端 IP 分桶：轮换 visitorId 不能获得新配额。"""
    admin_module.site_visit_limiter.reset()
    for index in range(admin_module.site_visit_limiter.max_hits):
        response = await _visit(client, "/", visitor=f"rotating-visitor-{index:04d}")
        assert response.status_code == 204, response.text
    response = await _visit(client, "/", visitor="brand-new-visitor")
    assert response.status_code == 429


@pytest.mark.asyncio
async def test_tz_offset_shifts_local_day_boundary(client, session):
    """UTC 昨晚 20:00 = 本地今天 04:00：两种时区别归到不同自然日。"""
    admin = await _user(session, "admin", ROLE_ADMIN)
    today_local = (utcnow() + timedelta(minutes=480)).date()
    event_utc = (
        datetime.combine(today_local, datetime.min.time())
        - timedelta(minutes=480)
        + timedelta(hours=4)
    )
    session.add(
        SiteVisitEvent(visitor_hash="boundary", path="/", occurred_at=event_utc)
    )
    await session.commit()

    token = await _token(client, admin.username)
    local = (await _dashboard(client, token, "days=7&tz_offset=480")).json()
    utc = (await _dashboard(client, token, "days=7&tz_offset=0")).json()

    local_row = next(i for i in local["daily"] if i["date"] == today_local.isoformat())
    utc_row = next(
        i
        for i in utc["daily"]
        if i["date"] == (today_local - timedelta(days=1)).isoformat()
    )
    assert local_row["pv"] == 1
    assert utc_row["pv"] == 1
    assert local["overview"]["totalPv"] == 1
    assert utc["overview"]["totalPv"] == 1


@pytest.mark.asyncio
async def test_dashboard_rejects_invalid_params(client, session):
    admin = await _user(session, "admin", ROLE_ADMIN)
    token = await _token(client, admin.username)
    assert (await _dashboard(client, token, "days=8")).status_code == 422
    assert (await _dashboard(client, token, "days=7&tz_offset=9999")).status_code == 422


@pytest.mark.asyncio
async def test_site_visit_rejects_invalid_payload(client):
    response = await client.post(
        "/api/site-visits", json={"path": "", "visitorId": ""}
    )
    assert response.status_code == 422
