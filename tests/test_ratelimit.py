"""进程内滑动窗口限流：超阈值必须 429，且窗口滑动后自动恢复。"""
import pytest
from fastapi import HTTPException

from app.core.ratelimit import SlidingWindowLimiter


def test_blocks_after_max_hits_with_retry_after():
    limiter = SlidingWindowLimiter(window_seconds=60, max_hits=2, detail="too many")
    limiter.check("k")
    limiter.check("k")
    with pytest.raises(HTTPException) as exc:
        limiter.check("k")
    assert exc.value.status_code == 429
    assert int(exc.value.headers["Retry-After"]) >= 1


def test_keys_are_independent_and_reset_clears_state():
    limiter = SlidingWindowLimiter(window_seconds=60, max_hits=1, detail="too many")
    limiter.check("a")
    with pytest.raises(HTTPException):
        limiter.check("a")
    limiter.check("b")  # 不同 key 不共享配额
    limiter.reset()
    limiter.check("a")


def test_window_slides(monkeypatch):
    limiter = SlidingWindowLimiter(window_seconds=10, max_hits=1, detail="too many")
    clock = [100.0]
    monkeypatch.setattr("app.core.ratelimit.time.monotonic", lambda: clock[0])
    limiter.check("k")
    clock[0] = 111.0
    limiter.check("k")  # 旧命中已出窗，不应再被拦


def test_rejects_invalid_config():
    with pytest.raises(ValueError):
        SlidingWindowLimiter(window_seconds=0, max_hits=1, detail="x")
    with pytest.raises(ValueError):
        SlidingWindowLimiter(window_seconds=60, max_hits=0, detail="x")
