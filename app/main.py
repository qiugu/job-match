"""FastAPI 应用入口：CORS、路由挂载、数据库初始化、请求日志与异常兜底。"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator
from typing import Any

import uuid
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import init_db
from app.core.logging import get_logger
from app.api import resume, match, ai, auth, cover_letter, jobs, export, admin, telemetry
from app.services.auth_bootstrap import bootstrap_auth
from app.services.pdf_export import shutdown_renderer

logger = get_logger("main")


async def _retention_cleanup_loop() -> None:
    """投递数据保留策略后台循环：启动清一次，之后每 24 小时一次。

    失败只记日志不退出循环——保留策略允许渐进清理，下一轮继续。
    """
    from app.services.job_cleanup import run_retention_cleanup

    while True:
        try:
            removed = await run_retention_cleanup()
            if removed:
                logger.info("投递数据保留策略：共清理过期归档卡 %d 张", removed)
        except Exception:
            logger.exception("投递数据保留策略执行失败（本轮跳过）")
        await asyncio.sleep(24 * 3600)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    logger.info("应用启动：初始化数据库")
    await init_db()
    # 配置了 AUTH_BOOTSTRAP_USERNAME/PASSWORD 时创建初始账号并接管历史数据
    await bootstrap_auth()
    logger.info("数据库初始化完成")
    # 投递数据保留策略（JOB_RETENTION_DAYS，默认 180 天）：后台任务而非阻塞启动
    retention_task = asyncio.create_task(_retention_cleanup_loop())
    yield
    retention_task.cancel()
    # 关闭服务端 PDF 渲染的共享 Chromium 单例（若已启动）
    await shutdown_renderer()
    logger.info("应用关闭")


async def _request_id(request: Request) -> str:
    """优先透传前端传入的 X-Request-ID，否则生成一个新的。"""
    rid = request.headers.get("x-request-id")
    return rid or uuid.uuid4().hex


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """捕获所有未处理异常，记录完整 traceback，返回带 request_id 的 500。

    路由内已明确捕获并转成 HTTPException / 503 的异常不会走到这里。
    """
    rid = await _request_id(request)
    logger.exception(
        "未捕获异常 | request_id=%s | %s %s",
        rid,
        request.method,
        request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"服务器内部错误，request_id={rid}，请携带该 ID 联系排查",
            "request_id": rid,
        },
    )


def create_app() -> FastAPI:
    app = FastAPI(title="JobMatch Agent", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # 跨域直连后端时（VITE_JOBMATCH_API 指向独立域名），前端 JS 需能读取
        # Retry-After 才能渲染限流倒计时；同源（Nginx 代理）下该头本就可读。
        expose_headers=["Retry-After"],
    )

    # 注册全局异常兜底：未处理异常 → 500 + request_id + 完整 traceback 日志
    app.add_exception_handler(Exception, _unhandled_exception_handler)  # type: ignore[arg-type]

    # 请求日志 ASGI 中间件：记录每个请求的状态码与耗时，便于排查 5xx
    app.add_middleware(RequestLogMiddleware)

    app.include_router(auth.router)
    app.include_router(resume.router)
    app.include_router(match.router)
    app.include_router(ai.router)
    app.include_router(cover_letter.router)
    app.include_router(jobs.router)
    app.include_router(export.router)
    app.include_router(admin.router)
    app.include_router(telemetry.router)

    @app.get("/health", tags=["health"])
    async def health():
        return {"status": "ok"}

    return app


class RequestLogMiddleware:
    """ASGI 中间件：为每个请求记录 method / path / 状态码 / 耗时 / request_id。

    采用纯 ASGI 中间件而非 BaseHTTPMiddleware，避免对 streaming response
    （如 /api/ai/polish 的 text/event-stream）产生缓冲副作用。
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        import time

        headers = scope.get("headers") or []
        request_id = next(
            (v.decode("latin1") for k, v in headers if k == b"x-request-id"),
            None,
        )
        if not request_id:
            request_id = uuid.uuid4().hex

        # 将关联 ID 和「到响应头」的应用耗时注入响应，便于与 Nginx 的
        # upstream timing 对比；只包装 send，不会缓冲流式响应正文。
        original_send = send

        async def send_with_timing(message) -> None:
            if message["type"] == "http.response.start":
                response_headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() not in {b"x-request-id", b"server-timing"}
                ]
                app_ms = (time.perf_counter() - start) * 1000
                response_headers.extend(
                    [
                        (b"x-request-id", request_id.encode("latin1")),
                        (b"server-timing", f"app;dur={app_ms:.1f}".encode("ascii")),
                    ]
                )
                message["headers"] = response_headers
            await original_send(message)

        send = send_with_timing

        method = scope.get("method", "?")
        path = scope.get("path", "?")
        start = time.perf_counter()
        status_code = "?"

        async def send_capture(message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", "?")
            await send(message)

        try:
            await self.app(scope, receive, send_capture)
        except Exception:
            # 全局异常处理器之外仍可能漏掉的异常（如中间件自身错误），记录后重新抛出
            logger.exception("请求处理异常 | request_id=%s | %s %s", request_id, method, path)
            raise
        finally:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.info(
                "请求完成 | request_id=%s | %s %s | status=%s | %.1fms",
                request_id,
                method,
                path,
                status_code,
                elapsed_ms,
            )


app = create_app()
