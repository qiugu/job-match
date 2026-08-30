#!/usr/bin/env bash
# 开发环境一键启动前后端（实时日志，Ctrl+C 关闭）
# 后端 7001（app/main.py），前端 4001（frontend/vite.config.ts）
cd "$(dirname "$0")"

# 后端
( uv run uvicorn app.main:app --host 0.0.0.0 --port 7001 --reload 2>&1 | sed -u 's/^/[后端] /' ) &
BACK=$!

# 前端
( cd frontend && pnpm dev --port 4001 2>&1 | sed -u 's/^/[前端] /' ) &
FRONT=$!

echo "前后端已启动，Ctrl+C 关闭。前端 http://localhost:4001  后端 http://localhost:7001/health"

# 阻塞主脚本，直到被 Ctrl+C；退出时关掉两个服务
trap 'kill $BACK $FRONT 2>/dev/null' EXIT INT TERM
wait
