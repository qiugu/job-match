"""Alembic 环境：基于 app.core 的异步引擎与元数据。

- 动态读取 app.core.config.settings 的 DATABASE_URL，避免硬编码。
- 使用异步引擎（aiosqlite）执行迁移。
- metadata 来自 app.core.database.Base，并导入所有模型以注册表。
"""
from __future__ import annotations

import sys
from pathlib import Path
from logging.config import fileConfig

# 将项目根目录加入 sys.path，确保 `app` 包可被导入
# （无论在仓库根目录还是任意工作目录运行 alembic 命令）
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from sqlalchemy.engine import Connection
from sqlalchemy import engine_from_config, pool

from alembic import context

from app.core.config import settings
from app.core.database import Base

# 导入模型以将表注册到 Base.metadata（必须，否则 autogenerate 看不到表）
import app.models  # noqa: F401

# Alembic Config 对象，提供访问 .ini 中配置的途径
config = context.config

# 用项目实际数据库 URL 覆盖 sqlalchemy.url（优先于 alembic.ini 中的占位值）。
# 迁移执行使用同步引擎：SQLite 的 DDL 在异步驱动（aiosqlite）下会脱离事务
# 立即落盘，导致「表已建好但 alembic_version 未提交」的不一致；同步引擎可保证
# DDL 与版本记录在单一事务内原子提交。模型元数据与驱动无关，可共用。
sync_url = settings.database_url.replace("sqlite+aiosqlite://", "sqlite://")
config.set_main_option("sqlalchemy.url", sync_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """离线模式：仅输出 SQL，不实际连接数据库。"""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # 支持 SQLite 的批处理（ALTER 需重建表）
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # 支持 SQLite 的批处理（ALTER 需重建表）
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：使用同步引擎执行迁移（SQLite DDL 与版本记录原子提交）。"""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        do_run_migrations(connection)
    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
