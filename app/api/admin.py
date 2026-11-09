"""管理员系统管理 API 与匿名站点浏览埋点。"""
from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_admin_user, get_db
from app.core.config import settings
from app.core.ratelimit import SlidingWindowLimiter, client_ip_from_request
from app.core.timeutils import utcnow
from app.models.site_visit_event import SiteVisitEvent
from app.services import ai_stats
from app.services.admin_stats import (
    DEFAULT_TZ_OFFSET,
    MAX_TZ_OFFSET,
    MIN_TZ_OFFSET,
    build_admin_dashboard,
)
from app.services.visit_path import normalize_visit_path

router = APIRouter(tags=["admin"])


class SiteVisitIn(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    visitorId: str = Field(min_length=8, max_length=128)


# 匿名可写端点必须限流：唯一约束已移除，换 visitorId 即可无限插入。
# 与 growth-events 各自持有独立实例，互不占用配额。
site_visit_limiter = SlidingWindowLimiter(
    window_seconds=60,
    max_hits=settings.anonymous_telemetry_rate_limit_per_minute,
    detail="访问上报过于频繁，请稍后再试",
)


@router.post("/api/site-visits", status_code=status.HTTP_204_NO_CONTENT, summary="记录匿名页面访问")
async def record_site_visit(
    payload: SiteVisitIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    visitor_hash = hashlib.sha256(payload.visitorId.encode("utf-8")).hexdigest()
    # 只按客户端 IP 分桶：若把 visitor_hash 也放进 key，攻击者每换一个
    # visitorId 就是一个新桶，限流会形同虚设。
    site_visit_limiter.check(client_ip_from_request(request))
    db.add(SiteVisitEvent(
        visitor_hash=visitor_hash,
        path=normalize_visit_path(payload.path),
        occurred_at=utcnow(),
    ))
    await db.commit()


@router.get("/api/admin/dashboard", summary="读取系统管理仪表盘")
async def admin_dashboard(
    days: int = 7,
    tz_offset: int = DEFAULT_TZ_OFFSET,
    _: object = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if days not in (7, 30, 90):
        raise HTTPException(status_code=422, detail="days 仅支持 7、30 或 90")
    if not MIN_TZ_OFFSET <= tz_offset <= MAX_TZ_OFFSET:
        raise HTTPException(status_code=422, detail="tz_offset 需在 -720 ~ 840 之间")
    return await build_admin_dashboard(db, days, tz_offset)


# AI 端点白名单：与 models/llm_usage.py 的 ENDPOINT_* 常量对齐，
# 避免把一个拼错的 endpoint 当成「某端点零调用」静默返回空数据。
AI_ENDPOINTS = {
    "match",
    "cover_letter",
    "ai.polish",
    "ai.grammar",
    "ai.resume_import",
    "ai.translate",
}


@router.get("/api/admin/ai/observability", summary="AI 端点跨用户观测")
async def admin_ai_observability(
    days: int = 30,
    tz_offset: int = 480,
    endpoint: str | None = None,
    _: object = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """管理员视角：跨用户调用量、失败清单与最近调用（含翻译字段摘要）。"""
    if days not in (7, 30, 90):
        raise HTTPException(status_code=422, detail="days 仅支持 7、30 或 90")
    if endpoint is not None and endpoint not in AI_ENDPOINTS:
        raise HTTPException(status_code=422, detail="不支持的 endpoint")
    return await ai_stats.compute_global_ai_observability(
        db, days=days, tz_offset=tz_offset, endpoint=endpoint
    )
