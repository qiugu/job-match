"""管理员系统管理 API。"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_admin_user, get_db
from app.models.site_visit import SiteVisit
from app.services.admin_stats import build_admin_dashboard

router = APIRouter(tags=["admin"])


class SiteVisitIn(BaseModel):
    path: str = Field(min_length=1, max_length=255)
    visitorId: str = Field(min_length=8, max_length=128)


@router.post("/api/site-visits", status_code=status.HTTP_204_NO_CONTENT, summary="记录匿名页面访问")
async def record_site_visit(payload: SiteVisitIn, db: AsyncSession = Depends(get_db)) -> None:
    visitor_hash = hashlib.sha256(payload.visitorId.encode("utf-8")).hexdigest()
    record = SiteVisit(
        visit_date=datetime.now(timezone.utc).date(),
        visitor_hash=visitor_hash,
        path=payload.path,
    )
    db.add(record)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()


@router.get("/api/admin/dashboard", summary="读取系统管理仪表盘")
async def admin_dashboard(
    days: int = 7,
    _: object = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if days not in (7, 30, 90):
        raise HTTPException(status_code=422, detail="days 仅支持 7、30 或 90")
    return await build_admin_dashboard(db, days)
