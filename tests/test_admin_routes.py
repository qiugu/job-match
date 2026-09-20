"""系统管理统计：管理员权限、访问去重与业务指标聚合。"""

from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.core.timeutils import utcnow
from app.models.derived_resume import DerivedResume
from app.models.job import Job
from app.models.master_resume import MasterResume
from app.models.site_visit import SiteVisit
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
async def test_admin_dashboard_aggregates_business_metrics_and_visits(client, session):
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

    first = await client.post(
        "/api/site-visits",
        json={"path": "/", "visitorId": "visitor-a"},
    )
    second = await client.post(
        "/api/site-visits",
        json={"path": "/", "visitorId": "visitor-a"},
    )
    third = await client.post(
        "/api/site-visits",
        json={"path": "/login", "visitorId": "visitor-a"},
    )
    assert first.status_code == second.status_code == third.status_code == 204

    token = await _token(client, admin.username)
    response = await client.get(
        "/api/admin/dashboard?days=7", headers=auth_headers(token)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["range"] == 7
    assert body["overview"]["users"] == 2
    assert body["overview"]["masterResumes"] == 1
    assert body["overview"]["derivedResumes"] == 1
    assert body["overview"]["jobs"] == 1
    assert len(body["daily"]) == 7
    assert sum(item["pv"] for item in body["daily"]) == 2
    assert sum(item["uv"] for item in body["daily"]) == 1

    visits = (await session.execute(select(SiteVisit))).scalars().all()
    assert len(visits) == 2


@pytest.mark.asyncio
async def test_site_visit_rejects_invalid_payload(client):
    response = await client.post(
        "/api/site-visits", json={"path": "", "visitorId": ""}
    )
    assert response.status_code == 422
