# 后端 FastAPI 服务镜像（使用 uv 管理依赖与虚拟环境）
FROM python:3.12-slim

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

WORKDIR /app

# 优先安装依赖以利用层缓存
# 仅复制依赖声明与锁定文件，避免代码改动导致依赖层失效
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# 拷贝后端代码
COPY app ./app
COPY run.py ./

# 拷贝 Alembic 迁移配置（数据库 schema 由 Alembic 管理）
COPY alembic.ini ./
COPY migrations ./migrations

# 通过 uv 的虚拟环境运行
ENV PATH="/app/.venv/bin:$PATH"

# 数据库与 .env 通过挂载/环境变量提供
# 生产启动统一监听 8000（可被 BACKEND_PORT 覆盖），关闭 reload
EXPOSE 8000

# 启动前显式升级数据库到最新版本，再以 uvicorn 直接运行（幂等、无 reload）
CMD ["sh", "-c", "python -m alembic upgrade head && uvicorn app.main:app --host ${BACKEND_HOST:-0.0.0.0} --port ${BACKEND_PORT:-8000}"]
