"""统一日志配置：为后端提供结构化、可排障的日志输出。

全项目统一使用本模块的 `get_logger()` 获取 logger，避免散落的 print /
裸 logging 导致格式不一致。日志格式包含：时间、级别、logger 名、进程/线程、
文件/行号与消息，便于在生产环境中快速定位问题。
"""
from __future__ import annotations

import logging
import sys
from typing import Union

# 项目根 logger 名：app.* 的 logger 均作为其子 logger，共享同一 Handler 与格式
_ROOT_LOGGER_NAME = "app"

# 默认日志级别：可通过环境变量 LOG_LEVEL 覆盖（DEBUG / INFO / WARNING / ERROR）
_DEFAULT_LEVEL = "INFO"

_FORMAT = (
    "%(asctime)s | %(levelname)-7s | %(name)s | "
    "%(filename)s:%(lineno)d | %(message)s"
)


def _resolve_level() -> int:
    import os

    level_name = os.getenv("LOG_LEVEL", _DEFAULT_LEVEL).strip().upper()
    return getattr(logging, level_name, logging.INFO)


def _configure() -> None:
    """配置根 logger 的格式与 Handler（幂等：重复调用不会重复加 Handler）。"""
    root = logging.getLogger(_ROOT_LOGGER_NAME)
    if getattr(root, "_codebuddy_configured", False):
        return

    root.setLevel(_resolve_level())
    root.propagate = False

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(handler)

    # 标记已配置，避免重复添加 Handler
    root._codebuddy_configured = True  # type: ignore[attr-defined]


def get_logger(name: Union[str, None] = None) -> logging.Logger:
    """获取统一配置的 logger。

    Args:
        name: logger 名称。通常传 `__name__`（形如 app.api.match）。
              省略时返回项目根 logger `app`。
    """
    _configure()
    if name:
        return logging.getLogger(f"{_ROOT_LOGGER_NAME}.{name}")
    return logging.getLogger(_ROOT_LOGGER_NAME)
