"""agent 超时重试分类单测：锁定「可重试 / 不可重试」判定契约。

依据需求：
- 超时、5xx、429、连接错误 → 可重试（触发有界重试 + 状态重置）
- 4xx（鉴权/余额/内容策略/入参）→ 不可重试（立即停止，不浪费额度）
"""
from __future__ import annotations

import asyncio

import pytest

from app.services.agent import MatchPermanentError, MatchTimeoutError, _is_retryable_error


class _FakeStatus(Exception):
    """模拟携带 HTTP 状态码的底层 LLM 异常。"""

    def __init__(self, status_code: int):
        super().__init__("boom")
        self.status_code = status_code


class _Nested(Exception):
    """模拟状态码包在 __cause__ 里的异常。"""

    def __init__(self, inner: Exception):
        super().__init__("wrap")
        self.__cause__ = inner


@pytest.mark.parametrize(
    "exc,expected",
    [
        (asyncio.TimeoutError(), True),            # 超时：可重试
        (_FakeStatus(500), True),                  # 5xx：可重试
        (_FakeStatus(502), True),
        (_FakeStatus(503), True),
        (_FakeStatus(504), True),
        (_FakeStatus(429), True),                  # 限流：可重试
        (_FakeStatus(400), False),                 # 内容策略/入参：不可重试
        (_FakeStatus(401), False),                 # 鉴权：不可重试
        (_FakeStatus(403), False),                 # 余额/权限：不可重试
        (_FakeStatus(422), False),                 # 入参校验：不可重试
        (_Nested(_FakeStatus(401)), False),        # 状态码在 __cause__：仍不可重试
        (_Nested(_FakeStatus(503)), True),         # 状态码在 __cause__：仍可重试
        (ValueError("unknown"), True),             # 无法判定状态码：默认可重试（不误杀瞬时故障）
    ],
)
def test_is_retryable_classification(exc, expected):
    assert _is_retryable_error(exc) is expected


def test_match_timeout_error_is_runtime_error():
    assert isinstance(MatchTimeoutError("t"), RuntimeError)


def test_match_permanent_error_is_runtime_error():
    assert isinstance(MatchPermanentError("p"), RuntimeError)
