"""简历 PDF 导出 API：把前端「打印版 HTML」交给服务端 Chromium 渲染为矢量 PDF。

端点前缀 /api/export：
  POST  /pdf   前端提交打印版 HTML（buildPrintHtml 产物）→ 返回矢量 PDF 文件

数据源约定：PDF 由**前端已经渲染好的 DOM**（#resume-preview）序列化而来——
模板是 React 组件，后端无法独立重渲染，因此接口只负责把 html 渲染成 PDF，
不接触简历数据本身，也不落库。渲染上下文禁用 JS、无任何用户凭据。

防护：
- 仅登录用户可用（get_current_user）；
- html 长度上限（pdf_export_max_html_bytes），防内存滥用；
- 单用户每小时导出次数上限（内存滑动窗口，pdf_export_rate_limit_per_hour）；
- script / on* 事件属性剥离 + 渲染禁 JS（纵深防御，见 services/pdf_export.py）；
- chromium 不可用时返回 503，前端引导用户走「浏览器打印/另存为 PDF」。
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.responses import Response

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.logging import get_logger
from app.models.user import User
from app.services.pdf_export import (
    PdfExportUnavailableError,
    PdfRenderFailedError,
    render_html_to_pdf,
)

logger = get_logger("api.export")

router = APIRouter(prefix="/api/export", tags=["export"])

RATE_WINDOW_SECONDS = 3600


class ExportPdfRequest(BaseModel):
    html: str = Field(..., description="打印版 HTML（buildPrintHtml 产物）")
    title: str = Field("resume", max_length=120, description="下载文件名（不含扩展名）")


# 每用户滑动窗口限流：{user_id: deque[timestamp]}
_rate_hits: dict[int, deque[float]] = defaultdict(deque)


def _check_rate_limit(user_id: int) -> None:
    now = time.monotonic()
    hits = _rate_hits[user_id]
    # 清理窗口外旧记录
    while hits and now - hits[0] > RATE_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= settings.pdf_export_rate_limit_per_hour:
        retry_after = int(RATE_WINDOW_SECONDS - (now - hits[0])) + 1
        raise HTTPException(
            status_code=429,
            detail=f"导出过于频繁，请稍后再试（{retry_after} 秒后恢复）",
            headers={"Retry-After": str(retry_after)},
        )
    hits.append(now)
    # 空闲用户清理，防字典无限膨胀
    if len(_rate_hits) > 10_000:
        for uid in [uid for uid, q in _rate_hits.items() if not q]:
            del _rate_hits[uid]


@router.post("/pdf")
async def export_pdf(
    body: ExportPdfRequest,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    html_bytes = len(body.html.encode("utf-8"))
    if html_bytes > settings.pdf_export_max_html_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"导出内容过大（{html_bytes // 1024}KB，上限"
                f"{settings.pdf_export_max_html_bytes // 1024}KB），请精简后重试"
            ),
        )

    _check_rate_limit(user.id)

    try:
        result = await render_html_to_pdf(body.html, settings.pdf_export_font_origin)
    except PdfExportUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except PdfRenderFailedError as exc:
        # 渲染阶段失败（浏览器崩溃/超时）：503 + 明确文案，而非裸 500
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    safe_name = quote(body.title.strip() or "resume", safe="")
    headers: dict[str, str] = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}.pdf",
        "X-Content-Type-Options": "nosniff",
    }
    if result.font_fallback_used:
        # 字体/图片服务端内联失败，PDF 已回退到系统字体；前端据此提示用户检查配置
        headers["X-Font-Fallback"] = "true"

    return Response(
        content=result.pdf,
        media_type="application/pdf",
        headers=headers,
    )
