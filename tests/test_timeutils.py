"""timeutils 测试：统一返回 UTC naive datetime。"""

from datetime import datetime, timezone

from app.core import timeutils


def test_utcnow_is_naive():
    now = timeutils.utcnow()
    assert isinstance(now, datetime)
    # 模块明确返回 naive，与 SQLite 读回的字段口径一致
    assert now.tzinfo is None


def test_utcnow_is_recent_and_utc():
    now = timeutils.utcnow()
    aware = datetime.now(timezone.utc).replace(tzinfo=None)
    delta = abs((now - aware).total_seconds())
    assert delta < 5


def test_utcnow_monotonic_increasing():
    a = timeutils.utcnow()
    b = timeutils.utcnow()
    assert b >= a
