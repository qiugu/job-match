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
- 账号登录：所有业务与 AI 接口需登录后调用，数据按用户隔离（详见「登录与鉴权」）
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

- 前端：http://localhost:3005
- 后端健康检查：http://localhost:8005/health

> 脚本会自动从 `.env.example` 复制生成后端 `.env`（若不存在），请填入 `LLM_API_KEY` 等配置后重启。

### 方式二：Docker Compose 一键部署（生产模式）

```bash
cp .env.example .env          # 填入 LLM_API_KEY 等
docker compose up -d --build  # 构建并后台启动 nginx + 后端 + 前端
```

启动后访问：

- 前端（经 Nginx 同源代理）：http://localhost
- 健康检查：http://localhost/health

**架构**：`nginx` 是唯一对外入口（宿主仅暴露 80/443），将 `/` 转发到 `frontend:3005`、将 `/api` 与 `/health` 转发到 `backend:8005`。`backend` 与 `frontend` 不再直接映射宿主端口，仅容器网络内可见，更安全。

数据持久化：后端 SQLite 数据库挂载在 `backend-data` 卷中（`/app/data/jobmatch.db`）。

> 启用 HTTPS：将真实证书放入 `nginx/certs/`（fullchain.pem / privkey.pem），在 `docker-compose.yml` 的 `nginx` 服务取消注释 `nginx.ssl.conf` 挂载与 `443` 端口，并注释掉 `nginx.conf` 那行；证书缺失时 `nginx.ssl.conf` 已内置自签名示例（`nginx/certs/selfsigned.*`，仅本地测试用）。

> 注意：前端通过 `import.meta.env.VITE_JOBMATCH_API` 在**构建期**确定后端地址。经 Nginx 同源代理时该值置空，前端以相对路径 `/api` 调用后端（彻底无跨域），无需直连后端端口。若需脱离代理直连（如纯开发），可传入 `http://backend:8005` 并重新 `docker compose up -d --build frontend`。

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
uv run uvicorn app.main:app --host 0.0.0.0 --port 8005 --reload
# 或直接使用虚拟环境
./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8005 --reload
```

健康检查：`GET http://localhost/health`（经 Nginx）；后端直连为 `http://localhost:8005/health`

## 登录与鉴权

所有业务接口（简历 / 匹配）与 AI 接口（润色 / 语法检查 / 简历导入）都要求登录：

- 后端统一持有 `LLM_API_KEY`，接口匿名可调用等同于把额度公开，因此登录后才能使用。
- 自建账号体系（用户名 + 口令）：口令用 `scrypt`（内存硬）加随机盐哈希，令牌为 HS256 JWT。
- 数据按用户隔离：列表只返回自己的简历，访问/修改他人资源一律返回 404。
- 简历标题唯一性的作用域是「用户内」，不同用户可以有同名简历。

| 接口                            | 说明                                              |
| ------------------------------- | ------------------------------------------------- |
| `POST /api/auth/register`       | 注册并登录（可用 `AUTH_ALLOW_REGISTRATION=false` 关闭） |
| `POST /api/auth/login`          | 登录，返回 `token` 与用户信息                     |
| `POST /api/auth/logout`         | 登出：递增 token_version，该账号已签发的令牌立即失效 |
| `GET  /api/auth/me`             | 当前登录用户                                      |
| `POST /api/auth/change-password`| 修改口令并返回新令牌                              |

前端：`frontend/src/lib/auth.ts` 负责令牌存取，`jobmatch.ts` 与 AI 代理路由
（`frontend/src/routes/api/*`）统一携带 `Authorization: Bearer <token>`；
收到 401 会清理令牌并跳转 `/login?redirect=<原路径>`。

### 注册码与匹配额度

注册账号必须提供注册码（`POST /api/auth/register` 的 `code` 字段）：

- 每个注册码带**过期时间**和**授予的匹配次数**（默认 20 次，JD 简历匹配与话术生成共享，可用 `REGISTRATION_DEFAULT_MATCHES` 调整）；
- 用该码注册的账号获得对应次数的「简历匹配 JD」额度——调用 LLM **之前**原子预扣，
  调用失败自动归还，即只在真正产出匹配结果时才消耗；
- 额度用完后 `POST /api/derived-resumes` 返回 403「匹配次数已用完」；
- 管理员账号（初始账号）不受限制：`matchQuota = -1` 表示无限。

发放注册码：官网「常见问题 → 使用需要登录吗」提供**自助领取**入口
（`GET/POST /api/auth/registration-code`），是注册码唯一的发放渠道：

- 每日限量 `REGISTRATION_DAILY_LIMIT`（默认 10 个），北京时间 0 点重置，
  每个网络每日限领 3 个；
- 领取的注册码有效期 `REGISTRATION_CODE_VALIDITY_DAYS`（默认 30 天），
  授予匹配次数 `REGISTRATION_DEFAULT_MATCHES`（默认 20 次）；
- 弹框顶部会展示当日剩余名额与下次重置时间。

### 初始账号与历史数据

升级到带登录的版本后，迁移会把登录前已有的简历挂到**不可登录**的 `legacy` 账号名下
（新注册用户看不到他人数据）。在 `.env` 中配置初始账号，服务启动时会自动创建它，
并把这些历史数据划归该账号——用初始账号登录即可继续看到原有简历：

```bash
AUTH_BOOTSTRAP_USERNAME=admin
AUTH_BOOTSTRAP_PASSWORD=至少8位
```

未配置初始账号时，自行注册的账号是空白的（看不到历史数据）。

> 升级后存量数据都挂在不可登录的 `legacy` 账号下。若已经升级过、想让某个已有账号接管，
> 可直接改归属（`<账号>` 换成目标用户名）：
>
> ```bash
> sqlite3 jobmatch.db "UPDATE master_resumes SET user_id = (SELECT id FROM users WHERE username='<账号>');"
> sqlite3 jobmatch.db "UPDATE derived_resumes SET user_id = (SELECT id FROM users WHERE username='<账号>');"
> sqlite3 jobmatch.db "DELETE FROM users WHERE username='legacy';"
> ```

## 环境变量（.env）

| 变量           | 说明                                                    |
| -------------- | ------------------------------------------------------- |
| `LLM_API_KEY`  | 国产大模型 API Key（必填，否则匹配接口返回 503）        |
| `LLM_BASE_URL` | OpenAI 兼容接口地址，如 `https://api.deepseek.com/v1`   |
| `LLM_MODEL`    | 模型名，如 `deepseek-chat`                              |
| `CORS_ORIGINS` | 前端来源，默认含 dev(3005)、经 Nginx 同源代理(80)、容器内 `http://frontend:3005` |
| `DATABASE_URL` | SQLite 路径（默认 `sqlite+aiosqlite:///./jobmatch.db`） |
| `AUTH_SECRET_KEY` | JWT 签名密钥（生产必填，≥32 字节；留空则重启即失效） |
| `AUTH_TOKEN_EXPIRE_MINUTES` | 登录令牌有效期（分钟，默认 10080）        |
| `AUTH_ALLOW_REGISTRATION` | 是否开放注册（默认 true）                      |
| `AUTH_BOOTSTRAP_USERNAME` / `AUTH_BOOTSTRAP_PASSWORD` | 初始账号（即管理员），创建时接管历史数据 |
| `REGISTRATION_DEFAULT_MATCHES` | 注册码默认授予的匹配次数（默认 20，JD 简历匹配与话术生成共享） |
| `REGISTRATION_DAILY_LIMIT` | 官网每日自助发放的注册码上限（默认 10，北京时间 0 点重置） |
| `REGISTRATION_CODE_VALIDITY_DAYS` | 自助领取的注册码有效期（天，默认 30） |

## 数据库迁移（Alembic）

数据库 schema 由 [Alembic](https://alembic.sqlalchemy.org/) 统一管理（替代原先启动时 `Base.metadata.create_all` 的方式），可追踪、可回滚、可演进。

- 迁移目录：`migrations/versions/`，配置：`alembic.ini`（位于仓库根）。
- `migrations/env.py` 动态读取 `app.core.config` 的 `DATABASE_URL`，无需硬编码；使用**同步引擎**执行迁移，避免 SQLite 在异步驱动（aiosqlite）下 DDL 脱离事务导致「表已建但版本未记录」的不一致。
- 应用启动时（`app.core.database.init_db`）会自动执行 `alembic upgrade head`，保证开发/生产环境 schema 始终最新且幂等。

### 升级前先备份

因为**重启后端就会自动升级**，所以在重启之前先备份，需要回退时把备份拷回 `jobmatch.db` 即可：

```bash
cp jobmatch.db "jobmatch.db.bak.$(date +%Y%m%d%H%M%S)"
```

### 登录与注册码相关的两个迁移

| 版本              | 内容                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e5b7c1a94d2f`    | 登录鉴权：建 `users` 表；`master_resumes` / `derived_resumes` 增加 `user_id`，存量数据统一挂到不可登录的 `legacy` 账号；标题唯一性改为 `(user_id, title)` |
| `a3f8e1c7b4d2`    | 注册码与匹配额度：建 `registration_codes` 表；`users` 增加 `role` / `match_quota` / `registered_code`，存量账号额度设为 `-1`（沿用不限制）            |

升级后存量数据会挂在 `legacy` 账号下，需要先用初始账号接管才能看到，见
[「初始账号与历史数据」](#初始账号与历史数据)。

降级注意：`e5b7c1a94d2f` 降级会把标题唯一性恢复为全局唯一，若存在多用户同名简历会失败，
需先手工处理同名数据。

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

> 除 `/api/auth/*` 与 `/health` 外，以下接口均需在请求头携带 `Authorization: Bearer <token>`。

- `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`
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
