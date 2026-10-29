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
from app.services import ai_stats
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
