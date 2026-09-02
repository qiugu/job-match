# syntax=docker.io/docker/dockerfile:1

# 后端 FastAPI 服务镜像（使用 uv 管理依赖与虚拟环境）
# 构建提速两点：
#   1. uv 版本固定（:latest 会随上游发版漂移，导致依赖安装层反复失效重建）
#   2. uv 下载缓存用 BuildKit cache mount 持久化——改依赖时只增量下载 wheel
FROM python:3.12-slim

# 固定 uv 版本（升级时手动改此标签，改完依赖层会重建一次属预期）
COPY --from=ghcr.io/astral-sh/uv:0.12.9 /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/root/.cache/uv
# 注意：未开启 UV_COMPILE_BYTECODE。该选项会在 uv sync 阶段就地编译所有 wheel 的
# 字节码，langchain/pymupdf 等大包编译时内存峰值极高，在 2G 小内存服务器上极易
# 触发 OOM（表现为构建卡死）。关闭后仅首次启动略慢，换取构建稳定。

WORKDIR /app

# 优先安装依赖以利用层缓存
# 仅复制依赖声明与锁定文件，避免代码改动导致依赖层失效
COPY pyproject.toml uv.lock ./
# cache mount：wheel 缓存放卷上不进镜像层，依赖变更无需全量重新下载
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# 拷贝后端代码
COPY app ./app
COPY run.py alembic.ini ./
COPY migrations ./migrations

# 通过 uv 的虚拟环境运行
ENV PATH="/app/.venv/bin:$PATH"

# 数据库与 .env 通过挂载/环境变量提供
# 生产启动统一监听 8005（可被 BACKEND_PORT 覆盖），关闭 reload
EXPOSE 8005

# 启动前显式升级数据库到最新版本，再以 uvicorn 直接运行（幂等、无 reload）
CMD ["sh", "-c", "python -m alembic upgrade head && uvicorn app.main:app --host ${BACKEND_HOST:-0.0.0.0} --port ${BACKEND_PORT:-8005}"]
