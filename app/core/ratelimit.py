"""进程内滑动窗口限流：为匿名可写端点提供最小可用的频率护栏。

取舍：单实例部署足够；多实例需换成 Redis 等共享存储（与 auth.py 登录限流
同一取舍）。使用 time.monotonic() 而非墙钟，避免系统时钟回拨造成窗口异常。
"""
from __future__ import annotations

import math
import time
from collections import defaultdict

from fastapi import HTTPException, Request

# 防止常驻进程下字典无限增长：超过该规模时清理一次已过期 key。
_MAX_TRACKED_KEYS = 4096


class SlidingWindowLimiter:
    """按任意 key 统计最近 window_seconds 内的命中数，超限抛 429。"""

    def __init__(self, *, window_seconds: float, max_hits: int, detail: str) -> None:
        if window_seconds <= 0 or max_hits <= 0:
            raise ValueError("window_seconds 与 max_hits 必须为正数")
        self._window = float(window_seconds)
        self._max_hits = int(max_hits)
        self._detail = detail
        self._hits: dict[str, list[float]] = defaultdict(list)

    @property
    def max_hits(self) -> int:
        """窗口上限（供测试读取，避免把阈值硬编码进用例）。"""
        return self._max_hits

    def check(self, key: str) -> None:
        """记录一次命中；超限时抛 HTTPException(429) 并附带 Retry-After。"""
        now = time.monotonic()
        hits = [t for t in self._hits[key] if now - t < self._window]
        if len(hits) >= self._max_hits:
            retry_after = max(1, math.ceil(self._window - (now - hits[0])))
            # 超限请求同样保留计数，否则窗口会被「先打满、再等待、再打满」绕过。
            self._hits[key] = hits
            raise HTTPException(
                status_code=429,
                detail=self._detail,
                headers={"Retry-After": str(retry_after)},
            )
        hits.append(now)
        self._hits[key] = hits
        if len(self._hits) > _MAX_TRACKED_KEYS:
            self._prune(now)

    def _prune(self, now: float) -> None:
        for key in list(self._hits):
            alive = [t for t in self._hits[key] if now - t < self._window]
            if alive:
                self._hits[key] = alive
            else:
                del self._hits[key]

    def reset(self) -> None:
        """清空计数器，仅供测试隔离使用（进程内限流器跨用例共享）。"""
        self._hits.clear()


def client_ip_from_request(request: Request) -> str:
    """取客户端 IP 用于限流分桶；不落库、不写日志。

    生产为单层 Nginx 反代（$proxy_add_x_forwarded_for）：真实客户端地址被
    追加在链尾，取链尾比取链首更难被伪造（客户端自带的 XFF 排在前面）。
    无该头时回落到连接对端地址。多层代理部署需重新校准取值位置。
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    candidates = [part.strip() for part in forwarded.split(",") if part.strip()]
    if candidates:
        return candidates[-1]
    return request.client.host if request.client else "unknown"
