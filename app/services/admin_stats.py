"""全站管理员仪表盘统计。"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.derived_resume import DerivedResume
from app.models.job import Job
from app.models.llm_usage import LlmUsage, USAGE_STATUS_SUCCESS
from app.models.master_resume import MasterResume
from app.models.site_visit import SiteVisit
from app.models.user import User


ALLOWED_RANGES = (7, 30, 90)


def _day(value: datetime | date) -> date:
    return value.date() if isinstance(value, datetime) else value


async def _group_by_day(session: AsyncSession, column, start: datetime, *conditions):
    rows = await session.execute(
        select(func.date(column).label("day"), func.count())
        .where(column >= start, *conditions)
        .group_by(func.date(column))
    )
    return {_day(datetime.fromisoformat(str(day)) if isinstance(day, str) else day): int(count) for day, count in rows}


async def build_admin_dashboard(session: AsyncSession, days: int) -> dict:
    if days not in ALLOWED_RANGES:
        days = 7
    today = datetime.now(timezone.utc).date()
    start_date = today - timedelta(days=days - 1)
    start = datetime.combine(start_date, datetime.min.time())

    users = int((await session.scalar(select(func.count()).select_from(User))) or 0)
    resumes = int((await session.scalar(select(func.count()).select_from(MasterResume))) or 0)
    matches = int((await session.scalar(select(func.count()).select_from(DerivedResume))) or 0)
    jobs = int((await session.scalar(select(func.count()).select_from(Job))) or 0)
    llm_calls = int((await session.scalar(select(func.count()).select_from(LlmUsage).where(LlmUsage.status == USAGE_STATUS_SUCCESS))) or 0)
    total_tokens = int((await session.scalar(select(func.coalesce(func.sum(LlmUsage.total_tokens), 0)).where(LlmUsage.status == USAGE_STATUS_SUCCESS))) or 0)
    credits_consumed = int((await session.scalar(
        select(func.coalesce(func.sum(case(
            (LlmUsage.endpoint == "match", settings.resume_match_cost),
            (LlmUsage.endpoint == "cover_letter", settings.cover_letter_cost),
            else_=0,
        )), 0)).where(LlmUsage.status == USAGE_STATUS_SUCCESS)
    )) or 0)

    new_users = await _group_by_day(session, User.created_at, start)
    daily_matches = await _group_by_day(session, DerivedResume.created_at, start)
    daily_jobs = await _group_by_day(session, Job.created_at, start)
    daily_llm = await _group_by_day(session, LlmUsage.created_at, start, LlmUsage.status == USAGE_STATUS_SUCCESS)

    visit_rows = await session.execute(
        select(SiteVisit.visit_date, func.count().label("pv"), func.count(func.distinct(SiteVisit.visitor_hash)).label("uv"))
        .where(SiteVisit.visit_date >= start_date)
        .group_by(SiteVisit.visit_date)
    )
    visits = {day: (int(pv), int(uv)) for day, pv, uv in visit_rows}

    daily = []
    for offset in range(days):
        current = start_date + timedelta(days=offset)
        pv, uv = visits.get(current, (0, 0))
        daily.append({
            "date": current.isoformat(),
            "pv": pv,
            "uv": uv,
            "newUsers": new_users.get(current, 0),
            "matches": daily_matches.get(current, 0),
            "jobs": daily_jobs.get(current, 0),
            "llmCalls": daily_llm.get(current, 0),
        })

    return {
        "range": days,
        "overview": {
            "users": users,
            "newUsers": sum(item["newUsers"] for item in daily),
            "masterResumes": resumes,
            "derivedResumes": matches,
            "jobs": jobs,
            "llmCalls": llm_calls,
            "totalTokens": total_tokens,
            "creditsConsumed": credits_consumed,
        },
        "daily": daily,
    }
