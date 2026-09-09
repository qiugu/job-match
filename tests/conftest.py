"""后端测试公共 fixtures。

设计原则（依据项目最佳实践：任何决定必须有证据，不依赖外部服务）：
- 使用临时文件 SQLite（aiosqlite）做隔离，避免污染 jobmatch.db。
- 用 Base.metadata.create_all 直接建表，比跑 Alembic 更快且隔离。
- 依赖 LLM 的路由（匹配/润色）由各测试按需 monkeypatch
  `app.api.match.run_match` 注入确定性结果，避免真实网络 / API key。
- 禁用注册/登录限流（内存计数器跨测试共享），以及对 quota / auth_bootstrap
  模块注入测试用 session factory（它们以 `from ... import AsyncSessionLocal`
  绑定了原 factory，需在测试期重定向）。
- 跳过应用 lifespan（内含 Alembic 迁移子进程），避免对真实库执行迁移。
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncGenerator, Callable

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.core.database as database_module
import app.services.auth_bootstrap as boot_module
import app.services.quota as quota_module
from app.main import app


@pytest_asyncio.fixture
async def engine():
    # 临时文件库，测试结束自动删除。
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    db_path = tmp.name
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{db_path}"

    eng = create_async_engine(
        f"sqlite+aiosqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    async with eng.begin() as conn:
        await conn.run_sync(database_module.Base.metadata.create_all)

    yield eng

    await eng.dispose()
    try:
        os.unlink(db_path)
    except OSError:
        pass


@pytest_asyncio.fixture
async def session_factory(engine) -> async_sessionmaker[AsyncSession]:
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory


@pytest_asyncio.fixture
async def session(session_factory) -> AsyncGenerator[AsyncSession, None]:
    async with session_factory() as s:
        yield s


@pytest.fixture(autouse=True)
def _test_isolation(monkeypatch, session_factory):
    # 将直接绑定 AsyncSessionLocal 的模块重定向到测试库（覆盖 get_db / quota / boot）。
    monkeypatch.setattr(database_module, "AsyncSessionLocal", session_factory)
    monkeypatch.setattr(quota_module, "AsyncSessionLocal", session_factory)
    monkeypatch.setattr(boot_module, "AsyncSessionLocal", session_factory)

    # 禁用注册/登录限流（内存计数器跨请求/跨测试累积，干扰回归）。
    import app.api.auth as auth_module

    monkeypatch.setattr(auth_module, "_check_register_ratelimit", lambda ip: None)
    monkeypatch.setattr(
        auth_module, "_check_login_ratelimit", lambda username, ip: None
    )


class _NoLifespanTransport(ASGITransport):
    """包装 ASGI app，跳过 lifespan（避免触发 Alembic 迁移子进程）。"""

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return
        await super().__call__(scope, receive, send)


@pytest_asyncio.fixture
async def client(session_factory) -> AsyncGenerator[AsyncClient, None]:
    transport = _NoLifespanTransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# 便于测试中直接构造已登录请求头的辅助函数。
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def make_auth_headers() -> Callable[[str], dict[str, str]]:
    return auth_headers
