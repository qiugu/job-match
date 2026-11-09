"""全站管理员仪表盘统计。

口径（2026-11-09 修订，见 docs/superpowers/plans/2026-09-20-admin-system-dashboard.md）：

- PV = site_visit_events 行数：一次页面浏览一行，刷新与回访照常计入。
- 日 UV = 当日 count(distinct visitor_hash)；区间 UV = 整个窗口内去重。
  **区间 UV 绝不能由每日 UV 求和得到**（跨天回访者会被重复计数）。
- 所有 daily 指标统一按 tz_offset（分钟，默认 UTC+8）换算的本地自然日切分：
  既避免 UTC 日界把北京时间 00:00-08:00 的访问归到前一天，也与同页 AI
  观测（同样支持 tz_offset）保持一致的时间口径。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.timeutils import utcnow
from app.models.derived_resume import DerivedResume
from app.models.growth_event import GrowthEvent
from app.models.job import Job
from app.models.llm_usage import LlmUsage, USAGE_STATUS_SUCCESS
from app.models.master_resume import MasterResume
from app.models.site_visit_event import SiteVisitEvent
from app.models.user import User


ALLOWED_RANGES = (7, 30, 90)
DEFAULT_TZ_OFFSET = 480  # UTC+8，与 AI 观测接口默认值一致
MIN_TZ_OFFSET = -720
MAX_TZ_OFFSET = 840
GROWTH_EVENT_FIELDS = {
    "landing_view": "landingView",
    "cta_click": "ctaClick",
    "register_start": "registerStart",
    "register_success": "registerSuccess",
    "resume_created": "resumeCreated",
    "first_match_success": "firstMatchSuccess",
    "session_start": "sessionStart",
}


def _day(value: object) -> date:
    """把 SQL 返回的日期值统一成 date（SQLite func.date 返回字符串）。"""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.fromisoformat(str(value)).date()


def _tz_modifier(tz_offset: int) -> str:
    """SQLite date() 的分钟偏移修饰符；项目既有统计已依赖 func.date()。"""
    return f"{tz_offset:+d} minutes"


def _local_day(column, tz_offset: int):
    """naive UTC 时间列 → 本地自然日（SQL 侧聚合，避免把事件全量拉进内存）。"""
    return func.date(column, _tz_modifier(tz_offset))


def _window(tz_offset: int, days: int) -> tuple[date, datetime, datetime]:
    """返回 (本地起始日, UTC 窗口起, UTC 窗口止)；窗口左闭右开。

    窗口边界同样按 tz_offset 平移，保证「本地 00:00」到「次日 00:00」的
    事件恰好落入，且不包含明天本地日的数据。
    """
    today_local = (utcnow() + timedelta(minutes=tz_offset)).date()
    start_local = today_local - timedelta(days=days - 1)
    start_utc = datetime.combine(start_local, datetime.min.time()) - timedelta(minutes=tz_offset)
    end_utc = datetime.combine(today_local + timedelta(days=1), datetime.min.time()) - timedelta(minutes=tz_offset)
    return start_local, start_utc, end_utc


async def _group_by_day(session: AsyncSession, column, start: datetime, end: datetime, tz_offset: int, *conditions):
    day = _local_day(column, tz_offset)
    rows = await session.execute(
        select(day.label("day"), func.count())
        .where(column >= start, column < end, *conditions)
        .group_by(day)
    )
    return {_day(value): int(count) for value, count in rows}


async def build_admin_dashboard(
    session: AsyncSession, days: int, tz_offset: int = DEFAULT_TZ_OFFSET
) -> dict:
    if days not in ALLOWED_RANGES:
        days = 7
    if not MIN_TZ_OFFSET <= tz_offset <= MAX_TZ_OFFSET:
        tz_offset = DEFAULT_TZ_OFFSET
    start_local, start_utc, end_utc = _window(tz_offset, days)

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

    new_users = await _group_by_day(session, User.created_at, start_utc, end_utc, tz_offset)
    daily_matches = await _group_by_day(session, DerivedResume.created_at, start_utc, end_utc, tz_offset)
    daily_jobs = await _group_by_day(session, Job.created_at, start_utc, end_utc, tz_offset)
    daily_llm = await _group_by_day(
        session, LlmUsage.created_at, start_utc, end_utc, tz_offset,
        LlmUsage.status == USAGE_STATUS_SUCCESS,
    )

    visit_day = _local_day(SiteVisitEvent.occurred_at, tz_offset)
    visit_rows = await session.execute(
        select(
            visit_day.label("day"),
            func.count().label("pv"),
            func.count(func.distinct(SiteVisitEvent.visitor_hash)).label("uv"),
        )
        .where(SiteVisitEvent.occurred_at >= start_utc, SiteVisitEvent.occurred_at < end_utc)
        .group_by(visit_day)
    )
    visits = {_day(value): (int(pv), int(uv)) for value, pv, uv in visit_rows}

    # 区间 UV 必须在整个窗口上重新去重；日 UV 相加会放大回访用户。
    unique_visitors = int((await session.scalar(
        select(func.count(func.distinct(SiteVisitEvent.visitor_hash)))
        .where(SiteVisitEvent.occurred_at >= start_utc, SiteVisitEvent.occurred_at < end_utc)
    )) or 0)
    total_pv = sum(pv for pv, _ in visits.values())

    growth_actor = case(
        (GrowthEvent.user_id.is_not(None), GrowthEvent.user_id),
        else_=GrowthEvent.visitor_hash,
    )
    growth_rows = await session.execute(
        select(GrowthEvent.event_name, func.count(func.distinct(growth_actor)))
        .where(GrowthEvent.occurred_at >= start_utc, GrowthEvent.occurred_at < end_utc)
        .group_by(GrowthEvent.event_name)
    )
    growth_counts = {name: int(count) for name, count in growth_rows}

    daily = []
    for offset in range(days):
        current = start_local + timedelta(days=offset)
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
        "tzOffset": tz_offset,
        "overview": {
            "users": users,
            "newUsers": sum(item["newUsers"] for item in daily),
            "masterResumes": resumes,
            "derivedResumes": matches,
            "jobs": jobs,
            "llmCalls": llm_calls,
            "totalTokens": total_tokens,
            "creditsConsumed": credits_consumed,
            "totalPv": total_pv,
            "uniqueVisitors": unique_visitors,
        },
        "daily": daily,
        "growthFunnel": {
            field: growth_counts.get(event_name, 0)
            for event_name, field in GROWTH_EVENT_FIELDS.items()
        },
    }
