"""匿名可写、严格限字段的增长事件 API。"""
from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, get_optional_user
from app.models.growth_event import GrowthEvent
from app.models.user import User
from app.schemas.telemetry import GrowthEventIn

router = APIRouter(prefix="/api/growth-events", tags=["telemetry"])


@router.post("", status_code=status.HTTP_204_NO_CONTENT, summary="记录增长漏斗事件")
async def record_growth_event(
    payload: GrowthEventIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
) -> None:
    record = GrowthEvent(
        event_id=payload.eventId,
        event_name=payload.eventName,
        visitor_hash=hashlib.sha256(payload.visitorId.encode("utf-8")).hexdigest(),
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
