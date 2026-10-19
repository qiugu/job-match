from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.database import create_database_engine


@pytest.mark.asyncio
async def test_sqlite_engine_uses_wal_and_waits_for_transient_locks(tmp_path: Path):
    engine = create_database_engine(f"sqlite+aiosqlite:///{tmp_path / 'perf.db'}")
    try:
        async with engine.connect() as connection:
            journal_mode = (
                await connection.execute(text("PRAGMA journal_mode"))
            ).scalar_one()
            synchronous = (
                await connection.execute(text("PRAGMA synchronous"))
            ).scalar_one()
            foreign_keys = (
                await connection.execute(text("PRAGMA foreign_keys"))
            ).scalar_one()
            busy_timeout = (
                await connection.execute(text("PRAGMA busy_timeout"))
            ).scalar_one()

        assert str(journal_mode).lower() == "wal"
        assert int(synchronous) == 1  # SQLite NORMAL
        assert int(foreign_keys) == 1
        assert int(busy_timeout) >= 30_000
    finally:
        await engine.dispose()
