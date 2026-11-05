"""统一可观测性 API：从 traces/spans 聚合的成功率、节点执行状态、成本用量。

替代旧的「匹配可观测性」（/api/derived-resumes/observability）与「翻译可观测性」
（/api/ai/translate/observability）两个割裂端点，统一为单一可观测性视图。

权限边界：
- 用户侧端点只读「自己」的 trace（get_current_user）；
- 管理员跨用户视图走 get_admin_user；
- 他人记录详情统一 404（不泄露存在性）。

days 白名单沿用 job_stats.ALLOWED_DAYS（7/14/30/90/180），与前端 ANALYTICS_DAYS 同步。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_admin_user, get_current_user, get_db
from app.models.llm_usage import (
    ENDPOINT_AI_GRAMMAR,
    ENDPOINT_AI_POLISH,
    ENDPOINT_AI_RESUME_IMPORT,
    ENDPOINT_AI_TRANSLATE,
    ENDPOINT_COVER_LETTER,
    ENDPOINT_JD_IMAGE_OCR,
    ENDPOINT_MATCH,
)
from app.models.user import User
from app.services.job_stats import ALLOWED_DAYS
from app.services.observability_stats import (
    compute_observability,
    get_trace_detail,
)

router = APIRouter(prefix="/api/observability", tags=["observability"])

# 端点白名单：与 llm_usage.ENDPOINT_* 对齐，避免拼错的 endpoint 静默返回空数据。
OBSERVABILITY_ENDPOINTS = {
    ENDPOINT_MATCH,
    ENDPOINT_COVER_LETTER,
    ENDPOINT_AI_POLISH,
    ENDPOINT_AI_GRAMMAR,
    ENDPOINT_AI_RESUME_IMPORT,
    ENDPOINT_AI_TRANSLATE,
    ENDPOINT_JD_IMAGE_OCR,
}


@router.get("", summary="统一可观测性统计")
async def observability(
    days: int = 30,
    tz_offset: int = 480,
    endpoint: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """当前用户自己的统一可观测视图（成功率/节点执行/成本）。"""
    if endpoint is not None and endpoint not in OBSERVABILITY_ENDPOINTS:
        raise HTTPException(status_code=422, detail="不支持的 endpoint")
    return await compute_observability(
        db, user_id=user.id, days=days, tz_offset=tz_offset, endpoint=endpoint
    )


@router.get("/traces/{trace_id}", summary="单次调用详情（span 时间线）")
async def trace_detail(
    trace_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await get_trace_detail(db, user.id, trace_id)
    if result is None:
        raise HTTPException(status_code=404, detail="调用记录不存在")
    return result


@router.get("/admin", summary="管理员跨用户统一可观测")
async def admin_observability(
    days: int = 30,
    tz_offset: int = 480,
    endpoint: str | None = None,
    _: object = Depends(get_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """管理员视角：跨用户调用量、节点执行、失败清单与成本归因。"""
    if days not in ALLOWED_DAYS:
        raise HTTPException(status_code=422, detail=f"days 仅支持 {ALLOWED_DAYS}")
    if endpoint is not None and endpoint not in OBSERVABILITY_ENDPOINTS:
        raise HTTPException(status_code=422, detail="不支持的 endpoint")
    return await compute_observability(
        db, user_id=None, days=days, tz_offset=tz_offset, endpoint=endpoint
    )
