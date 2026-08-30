"""后端启动入口：uvicorn 运行 FastAPI 应用。"""
import os

from app.main import app
from app.core.config import settings
from app.core.logging import get_logger

if __name__ == "__main__":
    import uvicorn

    logger = get_logger("run")
    logger.info(
        "启动后端服务 host=%s port=%s",
        settings.backend_host,
        settings.backend_port,
    )
    # uvicorn 自身日志级别跟随 LOG_LEVEL（默认 info）；reload 模式下依赖 import 触发配置
    uvicorn.run(
        "app.main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=True,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
        access_log=True,
    )
