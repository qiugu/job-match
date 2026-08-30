"""时间工具：统一「naive UTC」口径。

SQLite 的 DATETIME 列不保存时区，SQLAlchemy 读回的都是 naive datetime。
凡是与数据库时间字段比较/写入的地方都用它，避免 aware/naive 混用
抛出 `can't compare offset-naive and offset-aware datetimes`。
"""
from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """当前 UTC 时间（去掉 tzinfo，与 SQLite 读回的字段口径一致）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)
