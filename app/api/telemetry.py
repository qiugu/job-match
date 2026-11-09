"""匿名可写、严格限字段的增长事件 API。"""
from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, get_optional_user
from app.core.config import settings
from app.core.ratelimit import SlidingWindowLimiter, client_ip_from_request
from app.models.growth_event import GrowthEvent
from app.models.user import User
from app.schemas.telemetry import GrowthEventIn

router = APIRouter(prefix="/api/growth-events", tags=["telemetry"])

# eventId 幂等只挡重复投递，挡不住攻击者每次换 eventId 无限插库。
growth_event_limiter = SlidingWindowLimiter(
    window_seconds=60,
    max_hits=settings.anonymous_telemetry_rate_limit_per_minute,
    detail="事件上报过于频繁，请稍后再试",
)


@router.post("", status_code=status.HTTP_204_NO_CONTENT, summary="记录增长漏斗事件")
async def record_growth_event(
    payload: GrowthEventIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
) -> None:
    visitor_hash = hashlib.sha256(payload.visitorId.encode("utf-8")).hexdigest()
    growth_event_limiter.check(client_ip_from_request(request))
    record = GrowthEvent(
        event_id=payload.eventId,
        event_name=payload.eventName,
        visitor_hash=visitor_hash,
        user_id=user.id if user is not None else None,
        path=payload.path,
        referrer=payload.referrer,
        utm_source=payload.utmSource,
        utm_medium=payload.utmMedium,
        utm_campaign=payload.utmCampaign,
    )
    db.add(record)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # keepalive/网络重试可能重复投递同一 eventId；幂等成功即可。
        return
