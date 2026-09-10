# AGENTS.md

面向 AI 编程助手（CodeBuddy / Cursor / Claude Code 等）的项目指南。阅读本文件可快速了解仓库结构、技术栈与协作约定。

## 项目概览

简历匹配 Agent（job-matcher）：一个前后端分离的应用。

- **后端**：独立的 Python 服务（FastAPI + LangChain + LangGraph + SQLite），提供简历结构化存储与基于大模型的匹配/重写能力。
- **前端**：基于 TanStack Start（React + Vite）的简历编辑器 `frontend/`（原 magic-resume）。

前后端通过 REST API 通信：API 统一以 `/api` 为前缀。生产经 Nginx 同源代理（宿主 80/443），前端以相对路径 `/api` 调用，无需跨域；`VITE_JOBMATCH_API` 为空即同源相对路径，开发期可覆盖为 `http://localhost:8005`。

## 目录结构

```
matcher/
├── app/                  # 后端 Python 代码（FastAPI）
│   ├── api/              # 路由层（master.py, match.py ...）
│   ├── core/             # 配置、数据库、LLM 客户端等核心
│   ├── models/           # SQLAlchemy 模型
│   ├── schemas/          # Pydantic 请求/响应模型（与前端共用 ResumeData 契约）
│   ├── services/         # 业务逻辑、Agent、LLM 调用
│   ├── main.py           # FastAPI 应用入口
│   └── __init__.py
├── frontend/             # 前端 TanStack Start 应用
│   ├── src/              # 源码（routes, components, lib, types ...）
│   │   ├── types/resume.ts   # 与后端对齐的 ResumeData 类型
│   │   └── lib/jobmatch.ts    # 后端 API 客户端（读 VITE_JOBMATCH_API）
│   ├── Dockerfile        # 前端生产镜像（node:20-alpine -> server.mjs）
│   ├── server.mjs        # 生产静态 + SSR 服务器
│   ├── vite.config.ts    # Vite / TanStack Start 配置
│   └── package.json
├── Dockerfile            # 后端生产镜像（python:3.12-slim + uv）
├── docker-compose.yml    # 前后端一体编排（backend + frontend）
├── pyproject.toml        # 后端 Python 依赖声明（uv 管理）
├── uv.lock               # 后端依赖锁定文件（由 uv 生成）
├── start.sh              # 本地一键启动脚本（开发模式）
├── run.py                # 后端 uvicorn 启动入口
├── .env.example          # 后端环境变量模板
└── README.md             # 运行说明
```

## 技术栈

- 后端：Python 3.12、FastAPI、Uvicorn、SQLAlchemy 2 + aiosqlite、Pydantic v2、LangChain / LangGraph、pypdf、python-dotenv。
- 前端：Node 20、pnpm 10、React 18、TanStack Start / Router、Vite 7、Tailwind CSS 3、HeroUI、Tiptap、Zustand。
- 部署：Docker + Docker Compose。

## 常用命令

### 后端（仓库根目录，使用 uv 管理）

```bash
uv sync --no-dev                     # 创建 .venv 并安装依赖
cp .env.example .env                 # 填入 LLM_API_KEY 等
uv run uvicorn app.main:app --host 0.0.0.0 --port 8005 --reload
# 或
uv run python run.py
```

健康检查：`GET http://localhost:8005/health`

> 依赖管理统一使用 [uv](https://docs.astral.sh/uv/)：`pyproject.toml` 声明依赖，`uv.lock` 锁定版本（需提交）。虚拟环境在 `.venv/`。

### 前端（frontend/）

```bash
pnpm install
pnpm dev          # 开发服务器 http://localhost:3005
pnpm build        # 产出 dist/
pnpm start        # 生产服务器 node server.mjs（PORT=3005）

pnpm generate:assets       # 重新生成首屏图多尺寸版本与 og-image
pnpm generate:brand-icons  # 由 public/logo.svg 重新生成 icon.png / favicon.ico
pnpm generate:sitemap      # 重新生成 sitemap.xml
```

### 一键启动

```bash
./start.sh            # 本地同时启动前后端（开发模式）
./start.sh --build    # 强制安装依赖后启动
```

### Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps / logs -f / down
```

- 经 Nginx 同源代理：前端 `http://localhost`（宿主 80），后端 API 走 `/api`；健康检查 `http://localhost/health`
- `backend`/`frontend` 仅容器网络内可见（不直映宿主端口）；如需直连调试后端：`http://localhost:8005/health`（临时 `docker compose port` 或临时 ports 映射）
- 后端 SQLite 数据持久化于 `backend-data` 卷（`/app/data/jobmatch.db`）

## 环境变量（后端 `.env`）

| 变量                                                  | 说明                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LLM_API_KEY`                                         | 大模型 API Key（必填，缺失时匹配接口返回 503）                                                              |
| `LLM_BASE_URL`                                        | OpenAI 兼容接口地址，如 `https://api.deepseek.com/v1`                                                       |
| `LLM_MODEL`                                           | 模型名，如 `deepseek-chat`                                                                                  |
| `LLM_PROVIDER`                                        | 厂商标识，默认 `deepseek`                                                                                   |
| `LLM_TEMPERATURE`                                     | 采样温度，默认 `0.3`                                                                                        |
| `CORS_ORIGINS`                                        | 前端来源，默认含 dev(3005)、Nginx 同源代理(80)、`http://frontend:3005`                                      |
| `DATABASE_URL`                                        | SQLite 路径（默认 `sqlite+aiosqlite:///./jobmatch.db`）                                                     |
| `AUTH_SECRET_KEY`                                     | JWT 签名密钥（生产必填，≥32 字节；留空则重启即失效）                                                        |
| `AUTH_TOKEN_EXPIRE_MINUTES`                           | 登录令牌有效期（分钟，默认 10080）                                                                          |
| `AUTH_ALLOW_REGISTRATION`                             | 是否开放注册（默认 true）                                                                                   |
| `AUTH_BOOTSTRAP_USERNAME` / `AUTH_BOOTSTRAP_PASSWORD` | 初始账号（即管理员），创建时接管历史简历数据                                                                |
| `REGISTRATION_DEFAULT_CREDITS`                        | 注册码默认授予的积分（默认 50，JD 简历匹配与话术生成共享）                                                  |
| `RESUME_MATCH_COST`                                   | 每次 JD 简历匹配消耗的积分（默认 5）                                                                        |
| `COVER_LETTER_COST`                                   | 每次 JD 话术生成/重生成消耗的积分（默认 1）                                                                  |
| `PDF_EXPORT_FONT_ORIGIN`                              | 服务端 PDF 渲染的字体源：compose 默认 `http://frontend:3005`；本机 uvicorn 直跑需设 `http://localhost:3005` |
| `PDF_EXPORT_MAX_HTML_BYTES`                           | 导出接口接收 HTML 上限（默认 2MB）                                                                          |
| `PDF_EXPORT_TIMEOUT_SECONDS`                          | 单次渲染超时秒数（默认 30）                                                                                 |
| `PDF_EXPORT_MAX_CONCURRENCY`                          | 渲染并发上限（默认 2，受内存约束）                                                                          |
| `PDF_EXPORT_RATE_LIMIT_PER_HOUR`                      | 单用户每小时导出次数上限（默认 20）                                                                         |
| `BACKEND_HOST` / `BACKEND_PORT`                       | 监听地址/端口                                                                                               |

## 数据契约

前后端共用 `ResumeData` 结构化 JSON：

- 后端定义见 `app/schemas/`
- 前端类型见 `frontend/src/types/resume.ts`

修改结构时需两端同步，保持字段一致。

## 约定与最佳实践

- **修复问题**：从最佳实践角度分析原因再修复，不盲目打补丁。
- **API 路由**：后端路由统一加 `/api` 前缀，按资源拆分到 `app/api/` 下独立 Router。
- **依赖管理**：后端使用 `uv` 管理——改依赖时编辑 `pyproject.toml` 后执行 `uv lock` / `uv sync`，并提交 `uv.lock`；前端改依赖同步更新 `frontend/package.json` 并重新生成 `pnpm-lock.yaml`。
- **数据持久化**：不要将 `jobmatch.db`、`.env` 提交进仓库（见 `.gitignore`）。
- **数据库迁移**：schema 变更必须走 Alembic 迁移（`uv run alembic revision --autogenerate`），禁止改模型后不写迁移；应用启动会自动 `upgrade head`，因此**重启后端前先备份** `jobmatch.db`。
- **LLM 调用**：统一经由 `app/core` 中的客户端封装，便于切换厂商（DeepSeek / 通义 / 智谱等）。
- **品牌标识**：改标只改 `frontend/public/logo.svg`（唯一几何源），随后执行 `pnpm generate:brand-icons` 同步 `icon.png` / `favicon.ico`，并递增 `src/routes/__root.tsx` 中 favicon 的 `?v=` 版本号以刷新浏览器缓存。完整规范见 `docs/BRAND.md`。
- **前端构建产物**：`frontend/dist/` 为构建输出，勿手动编辑。
- **提交前**：确保 linter/类型检查通过；新增脚本（如 `start.sh`）需 `chmod +x`。
