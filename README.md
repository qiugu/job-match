# 简历匹配 Agent 后端

独立的 Python 后端服务（FastAPI + LangChain + LangGraph + SQLite），为前端 `frontend/`（magic-resume）提供简历匹配能力。

## 功能

- 上传简历（**仅 PDF**），提取文本并存储（SQLite），作为匹配时可选择的简历
- 手动创建简历，使用 Markdown 编辑器编辑简历，保存并提取文本存储
- 创建匹配简历：根据粘贴的岗位描述（JD）文本，对所选**简历（markdown 文本）**进行匹配优化
  - 匹配方式（关键词优化 `optimize` / 全部重写 `rewrite`）由 AI 在匹配时**自动判断**，无需用户手动选择
  - 匹配入口直接接收所选简历的 markdown 文本，不再依赖「主简历」溯源概念
- 可选求职信：约 150 字纯文本
- 衍生简历为独立的匹配结果记录，支持二次编辑回写
- 先接国产大模型（默认 DeepSeek 兼容接口，可换通义/智谱等）

## 运行

> 后端代码位于仓库根目录（`app/`、`pyproject.toml`、`uv.lock`、`run.py` 等），使用 [uv](https://docs.astral.sh/uv/) 管理依赖与虚拟环境，无需进入子目录。

### 方式一：一键本地启动（开发模式）

同时拉起后端（uvicorn + reload）与前端（Vite dev）：

```bash
./start.sh            # 直接启动（已装依赖时）
./start.sh --build    # 首次或依赖变更时，强制安装依赖后启动
```

启动后访问：

- 前端：http://localhost:4001
- 后端健康检查：http://localhost:7001/health

> 脚本会自动从 `.env.example` 复制生成后端 `.env`（若不存在），请填入 `LLM_API_KEY` 等配置后重启。

### 方式二：Docker Compose 一键部署（生产模式）

```bash
cp .env.example .env          # 填入 LLM_API_KEY 等
docker compose up -d --build  # 构建并后台启动后端 + 前端
```

启动后访问：

- 前端：http://localhost:3000
- 后端：http://localhost:8000/health

数据持久化：后端 SQLite 数据库挂载在 `backend-data` 卷中（`/app/data/jobmatch.db`）。

> 注意：前端通过 `import.meta.env.VITE_JOBMATCH_API` 在**构建期**确定后端地址，已在 `docker-compose.yml` 的 `frontend.build.args` 中传入 `http://backend:8000`。若需改后端地址，必须重新 `docker compose up -d --build frontend`，仅改运行时环境变量无效。

常用命令：

```bash
docker compose ps             # 查看状态
docker compose logs -f        # 查看日志
docker compose down           # 停止并移除容器（保留数据卷）
```

### 手动启动（分服务）

```bash
# 后端（需先安装 uv：https://docs.astral.sh/uv/getting-started/installation/）
uv sync --no-dev              # 创建 .venv 并安装依赖
cp .env.example .env          # 填入 LLM_API_KEY 等
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
# 或直接使用虚拟环境
./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

健康检查：`GET http://localhost:8000/health`

## 环境变量（.env）

| 变量           | 说明                                                    |
| -------------- | ------------------------------------------------------- |
| `LLM_API_KEY`  | 国产大模型 API Key（必填，否则匹配接口返回 503）        |
| `LLM_BASE_URL` | OpenAI 兼容接口地址，如 `https://api.deepseek.com/v1`   |
| `LLM_MODEL`    | 模型名，如 `deepseek-chat`                              |
| `CORS_ORIGINS` | 前端来源，默认 `http://localhost:3000`                  |
| `DATABASE_URL` | SQLite 路径（默认 `sqlite+aiosqlite:///./jobmatch.db`） |

## 数据库迁移（Alembic）

数据库 schema 由 [Alembic](https://alembic.sqlalchemy.org/) 统一管理（替代原先启动时 `Base.metadata.create_all` 的方式），可追踪、可回滚、可演进。

- 迁移目录：`migrations/versions/`，配置：`alembic.ini`（位于仓库根）。
- `migrations/env.py` 动态读取 `app.core.config` 的 `DATABASE_URL`，无需硬编码；使用**同步引擎**执行迁移，避免 SQLite 在异步驱动（aiosqlite）下 DDL 脱离事务导致「表已建但版本未记录」的不一致。
- 应用启动时（`app.core.database.init_db`）会自动执行 `alembic upgrade head`，保证开发/生产环境 schema 始终最新且幂等。

常用命令（需在仓库根目录执行，且 `.venv` 已就绪）：

```bash
# 升级到最新版本（应用启动会自动执行，亦可手动运行）
uv run alembic upgrade head

# 查看迁移历史与当前版本
uv run alembic history
uv run alembic current

# 生成新的迁移（修改模型后）
uv run alembic revision --autogenerate -m "描述本次变更"

# 回滚到上一个版本（或 base 回到空库）
uv run alembic downgrade -1
uv run alembic downgrade base

# 将现有数据库标记为已应用某版本（不实际执行 DDL，用于初始化已有库）
uv run alembic stamp head
```

> 注意：`alembic` 命令读取 `DATABASE_URL` 环境变量（与 `.env` 一致）。修改模型字段后务必跑 `--autogenerate` 并核对生成的 SQL 再提交。

## API 一览

- `POST /api/master-resumes` 上传简历 PDF
- `GET  /api/master-resumes` 列表
- `GET  /api/master-resumes/{id}` 详情
- `PUT  /api/master-resumes/{id}` 更新结构化数据
- `POST /api/derived-resumes` 创建匹配简历（触发 Agent），请求体携带简历文本 `resumeText`
- `GET  /api/derived-resumes` 列表
- `GET  /api/derived-resumes/{id}` 详情（含求职信）
- `PUT  /api/derived-resumes/{id}` 二次编辑回写
- `GET  /api/derived-resumes/{id}/cover-letter` 求职信

## 数据契约

前后端共用 `ResumeData` 结构化 JSON（对齐 `frontend/src/types/resume.ts`），用于简历存储与编辑器。
注意：匹配接口（`POST /api/derived-resumes`）的匹配对象为所选简历的 **markdown 文本**（前端直接传 `resumeText`），其产出的衍生简历 `resume_json` 也是 **markdown 文本**，而非 `ResumeData` JSON。

## 验收

需求清单与检查单见 [CHECKLIST.md](./CHECKLIST.md)，全部项已验证通过。

## 前端：Markdown 编辑模式（所见即所得）

除原有的结构化表单编辑外，工作台（Workbench）新增 **Markdown 编辑模式**，满足偏好纯文本撰写的用户。

### 架构

```
Markdown 源 ──► Tiptap 编辑器 ──► 实时 Markdown 文本
                                      │
                                      ▼
                            markdown-it 解析（Markdown Parser）
                                      │
                                      ▼
                            React 渲染（A4 纸张 / HTML·CSS）
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                       实时预览                  PDF 导出（复用服务端 Playwright）
```

### 关键文件

- `frontend/src/components/editor/MarkdownEditor.tsx` — 基于 Tiptap + `tiptap-markdown` 的 Markdown 源编辑器
- `frontend/src/utils/markdownRender.ts` — 基于 `markdown-it` 的 Markdown Parser（输出 HTML）
- `frontend/src/components/preview/MarkdownPreview.tsx` — React Renderer（A4 纸张渲染 + 导出锚点 `#resume-preview`）
- `frontend/src/components/editor/MarkdownWorkbench.tsx` — 左编辑器 / 右预览分栏布局
- `frontend/src/app/app/workbench/[id]/page.tsx` — 在工作台顶部提供「表单编辑 / Markdown 编辑」切换
- `ResumeData.markdownContent`（`frontend/src/types/resume.ts`）— 存放 Markdown 源，与结构化数据并存

### 使用

1. 打开任意简历工作台（`/app/workbench/:id`）。
2. 顶部切换为「Markdown 编辑」。
3. 左侧编写 Markdown，右侧实时预览，可一键「导出 PDF」（所见即所得）。

### 新增依赖

- `tiptap-markdown`（Tiptap v3 官方 Markdown 扩展）
- `markdown-it`（Markdown 解析）
- `@tiptap/extension-placeholder`（编辑区占位提示）
