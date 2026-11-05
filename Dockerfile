# syntax=docker.io/docker/dockerfile:1

# 后端 FastAPI 服务镜像（使用 uv 管理依赖与虚拟环境）
# 构建提速两点：
#   1. uv 版本固定（:latest 会随上游发版漂移，导致依赖安装层反复失效重建）
#   2. BuildKit 层缓存复用依赖；cache mount 仅在同一 builder 上复用下载，
#      不会随 GHA 层缓存自动迁移到下一台临时 runner
FROM python:3.12-slim

# 固定 uv 版本（升级时手动改此标签，改完依赖层会重建一次属预期）
COPY --from=ghcr.io/astral-sh/uv:0.12.9 /uv /usr/local/bin/uv

# Playwright 浏览器二进制镜像源：国内服务器（腾讯云）访问官方 CDN（azureedge）极慢，
# 改用 npmmirror 二进制镜像可把 Chromium 下载从「小时级」降到「分钟级」。
# 若部署到海外，可覆盖为空：docker compose build --build-arg PLAYWRIGHT_DOWNLOAD_HOST=
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/root/.cache/uv \
    # Chromium is copied into this stable runtime path below. Keeping the
    # runtime path separate from the BuildKit cache mount makes the browser
    # available in the image while still allowing later builds to reuse the
    # downloaded archive.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # 防御性兜底：放宽依赖下载超时，避免 CI/远端构建在拉取较大 wheel 时因
    # 瞬时网络抖动而失败（默认仅 30s，曾导致 pypdfium2 下载超时阻断构建）。
    UV_HTTP_TIMEOUT=300 \
    # Playwright 镜像源（见上方 ARG）：加速 Chromium 下载。
    PLAYWRIGHT_DOWNLOAD_HOST=$PLAYWRIGHT_DOWNLOAD_HOST
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

# 本地/海外构建默认使用 Debian 官方源；Compose 的国内部署可覆盖为 HTTPS 镜像。
# 同时覆盖安全更新源，保留发行版及 Debian 签名验证。
ARG DEBIAN_MIRROR=https://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=https://deb.debian.org/debian-security
COPY scripts/configure-apt.sh /usr/local/bin/configure-apt
RUN sh /usr/local/bin/configure-apt "$DEBIAN_MIRROR" "$DEBIAN_SECURITY_MIRROR"

# 服务端 PDF 导出（矢量渲染）依赖：
#   - playwright install --with-deps --only-shell chromium：安装无头 Chromium 及系统依赖
#     （镜像体积 +~200MB，属一次性成本；渲染在首次请求时懒加载）
#   - fonts-noto-cjk：中文字体兜底。若 EXPORT_FONT_ORIGIN 指向的前端字体源
#     不可达，Chromium 仍能渲染中文，避免豆腐块（主字体仍走站点字体源）
# 系统依赖 + 中文字体兜底（仅安装一次；apt 缓存挂载加速重装，已装库仍写入镜像层）
RUN --mount=type=cache,target=/var/cache/apt,id=apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,id=apt-lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk

# Playwright Chromium：下载目录使用独立的 BuildKit cache mount。安装命令先把浏览器
# 放入缓存目录，再复制到 /ms-playwright 这个最终镜像路径；这样缓存命中时不会重新
# 从 CDN 下载 Chromium，同时运行时镜像仍然自带浏览器。下载走 PLAYWRIGHT_DOWNLOAD_HOST
# 镜像源（可覆盖）；GitHub Actions 通过 SSH 在服务器上执行此构建。
# PDF 服务使用默认无头模式，只安装 headless shell，不下载完整 Chromium。
# 上游依赖层不变时复用浏览器层；任何依赖层变化都可能使本层失效。
# --with-deps 所需系统库走上方 apt 缓存。
RUN --mount=type=cache,target=/var/cache/apt,id=apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,id=apt-lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/ms-playwright,id=playwright-browsers,sharing=locked \
    required_browser_dirs="$(PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright .venv/bin/playwright install --dry-run --only-shell chromium | sed -n 's/^  Install location: //p')" \
    && PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
       .venv/bin/playwright install --with-deps --only-shell chromium \
    && rm -rf /ms-playwright \
    && mkdir -p /ms-playwright \
    && for browser_dir in $required_browser_dirs; do \
         test -d "$browser_dir" \
           || { echo "Missing Playwright browser directory: $browser_dir" >&2; exit 1; }; \
         cp -a "$browser_dir" /ms-playwright/; \
       done

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
