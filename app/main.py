"""FastAPI 应用入口：CORS、路由挂载、数据库初始化、请求日志与异常兜底。"""
from __future__ import annotations

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
from app.api import resume, match, ai, auth
from app.services.auth_bootstrap import bootstrap_auth

logger = get_logger("main")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    logger.info("应用启动：初始化数据库")
    await init_db()
    # 配置了 AUTH_BOOTSTRAP_USERNAME/PASSWORD 时创建初始账号并接管历史数据
    await bootstrap_auth()
    logger.info("数据库初始化完成")
    yield
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
    )

    # 注册全局异常兜底：未处理异常 → 500 + request_id + 完整 traceback 日志
    app.add_exception_handler(Exception, _unhandled_exception_handler)  # type: ignore[arg-type]

    # 请求日志 ASGI 中间件：记录每个请求的状态码与耗时，便于排查 5xx
    app.add_middleware(RequestLogMiddleware)

    app.include_router(auth.router)
    app.include_router(resume.router)
    app.include_router(match.router)
    app.include_router(ai.router)

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
            # 尽量把生成的 request_id 注入响应头（在 send 外层包装）
            original_send = send

            async def send_with_rid(message) -> None:
                if message["type"] == "http.response.start":
                    headers_list = list(message.get("headers", []))
                    headers_list.append((b"x-request-id", request_id.encode("latin1")))
                    message["headers"] = headers_list
                await original_send(message)

            send = send_with_rid

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
