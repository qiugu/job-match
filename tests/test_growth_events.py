"""增长事件台账的写入契约。"""

import pytest
from sqlalchemy import func, select

from app.models.growth_event import GrowthEvent
from app.services.admin_stats import build_admin_dashboard


def _event(event_id: str, event_name: str = "landing_view") -> dict[str, str]:
    return {
        "eventId": event_id,
        "eventName": event_name,
        "visitorId": "visitor-12345678",
        "path": "/zh",
        "referrer": "https://example.com/article",
        "utmSource": "xiaohongshu",
        "utmMedium": "social",
        "utmCampaign": "autumn-jobs",
    }


@pytest.mark.asyncio
async def test_anonymous_growth_event_endpoint_accepts_allowlisted_event(client):
    response = await client.post("/api/growth-events", json=_event("evt-anon-1"))

    assert response.status_code == 204, response.text


@pytest.mark.asyncio
async def test_anonymous_growth_event_hashes_visitor_id(client, session):
    response = await client.post("/api/growth-events", json=_event("evt-anon-2"))

    assert response.status_code == 204, response.text
    row = (
        await session.execute(
            select(GrowthEvent).where(GrowthEvent.event_id == "evt-anon-2")
        )
    ).scalar_one()
    assert row.event_name == "landing_view"
    assert row.user_id is None
    assert row.visitor_hash != "visitor-12345678"
    assert len(row.visitor_hash) == 64
    assert row.utm_source == "xiaohongshu"


@pytest.mark.asyncio
async def test_growth_event_rejects_unknown_name(client):
    response = await client.post(
        "/api/growth-events", json=_event("evt-bad-1", "arbitrary_event")
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_growth_event_is_idempotent_by_event_id(client, session):
    payload = _event("evt-duplicate-1", "cta_click")

    first = await client.post("/api/growth-events", json=payload)
    second = await client.post("/api/growth-events", json=payload)

    assert first.status_code == 204
    assert second.status_code == 204
    count = await session.scalar(
        select(func.count())
        .select_from(GrowthEvent)
        .where(GrowthEvent.event_id == "evt-duplicate-1")
    )
    assert count == 1


@pytest.mark.asyncio
async def test_authenticated_growth_event_is_linked_to_user(client, session):
    register = await client.post(
        "/api/auth/register",
        json={"username": "growthuser", "password": "Pass#1234"},
    )
    assert register.status_code == 200, register.text
    token = register.json()["token"]
    user_id = register.json()["user"]["id"]

    response = await client.post(
        "/api/growth-events",
        headers={"Authorization": f"Bearer {token}"},
        json=_event("evt-user-1", "resume_created"),
    )

    assert response.status_code == 204, response.text
    row = (
        await session.execute(
            select(GrowthEvent).where(GrowthEvent.event_id == "evt-user-1")
        )
    ).scalar_one()
    assert row.user_id == user_id


@pytest.mark.asyncio
async def test_admin_dashboard_counts_distinct_growth_actors(client, session):
    await client.post("/api/growth-events", json=_event("evt-land-1"))
    await client.post("/api/growth-events", json=_event("evt-land-2"))
    await client.post(
        "/api/growth-events", json=_event("evt-cta-1", "cta_click")
    )

    dashboard = await build_admin_dashboard(session, 7)

    assert dashboard["growthFunnel"]["landingView"] == 1
    assert dashboard["growthFunnel"]["ctaClick"] == 1
    assert dashboard["growthFunnel"]["registerSuccess"] == 0
