"""SQLite 数据库初始化与异步会话。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings



def _is_sqlite_url(database_url: str) -> bool:
    return database_url.startswith("sqlite")


def _configure_sqlite_connection(dbapi_connection, _connection_record) -> None:
    """配置每条 aiosqlite 连接，降低并发读写时的锁等待。"""

    async def configure(raw_connection) -> None:
        await raw_connection.execute("PRAGMA journal_mode=WAL")
        await raw_connection.execute("PRAGMA synchronous=NORMAL")
        await raw_connection.execute("PRAGMA foreign_keys=ON")
        await raw_connection.execute("PRAGMA busy_timeout=30000")
        await raw_connection.commit()

    dbapi_connection.run_async(configure)


def create_database_engine(database_url: str):
    """创建应用数据库引擎；SQLite 额外启用 WAL 与 30 秒忙等待。"""
    connect_args = {"timeout": 30} if _is_sqlite_url(database_url) else {}
    database_engine = create_async_engine(
        database_url,
        echo=False,
        future=True,
        connect_args=connect_args,
    )
    if _is_sqlite_url(database_url):
        event.listen(
            database_engine.sync_engine.pool,
            "connect",
            _configure_sqlite_connection,
        )
    return database_engine


engine = create_database_engine(settings.async_database_url)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def _run_migrations() -> None:
    """同步执行 Alembic 迁移到最新版本（head）。

    使用独立进程运行 `alembic upgrade head`：
    - 与 app 同一 Python 解释器/虚拟环境，复用 env.py 中的同步引擎配置；
    - SQLite 的 DDL 在同步引擎下能与 alembic_version 写入处于同一事务，
      避免「表已建但版本未记录」的不一致（异步 aiosqlite 的已知局限）；
    - 该操作幂等：已是最新版本时 Alembic 不会重复执行。
    """
    # alembic.ini 位于仓库根目录（即 app/ 的上一级）
    root_dir = Path(__file__).resolve().parent.parent.parent
    ini_path = root_dir / "alembic.ini"
    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ini_path), "upgrade", "head"],
        cwd=str(root_dir),
        check=True,
    )


async def init_db() -> None:
    # 延迟导入模型以注册表（确保元数据完整）
    from app.models import (  # noqa: F401
        user,
        registration_code,
        master_resume,
        derived_resume,
        cover_letter,
        job,
        llm_usage,
        match_run,
        match_run_step,
        site_visit,
        growth_event,
    )

    # 数据库 schema 由 Alembic 迁移统一管理，启动时确保已升级到最新版本。
    # 若迁移系统尚未初始化（无 alembic_version 表），则自动执行升级以建表，
    # 保证开发期直接 `uv run python run.py` 也能立即工作。
    _run_migrations()


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
