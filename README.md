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

### GitHub Actions 构建与镜像拉取优化

前后端镜像通过 matrix 在独立 Runner 上并行构建，两者成功后才进入部署；手动 `no_build=true` 仍可跳过构建。构建使用 `docker/build-push-action` 自动接入 GHA 缓存认证，前后端分别保留缓存；临时 Runner 的 cache mount 不会随层缓存自动恢复。缓存导出最多等待 5 分钟，导出失败不阻断镜像归档生成。

GitHub Runner 的 Playwright 下载使用官方 CDN；后端只安装 PDF 导出所需的 Chromium headless shell，减少下载和镜像体积。本地 Docker 构建保留国内镜像源默认值。

每个构建 job 最多运行 30 分钟，部署 job 最多 90 分钟。构建 Runner 使用 `load: true` 保留本地镜像，压缩为 Actions Artifact；部署 Job 下载两个归档后，通过现有 SSH 凭据和 rsync 断点续传到服务器，再执行 `docker load`。部署路径不执行 `docker pull`，因此生产服务器不需要访问 GHCR/TCR。SSH 传输每个归档最多尝试 3 次，单次 rsync 最多 55 分钟；`--timeout=60` 只限制连续 60 秒无数据，允许 1GB 级归档在慢链路上正常完成。传输或加载失败会停止部署，不进入数据库迁移。无需新增 Secrets。服务器需有归档与镜像解包所需的空闲磁盘；成功后清理临时归档，失败时保留 `.deploy-images/` 中的部分归档以便下次断点续传。

上述超时属于异常保护，不代表保证在该时间内构建成功。排查时分别查看 `Build (backend)`、`Build (frontend)`、`Download image archives`、`Transfer images over SSH` 和远程 `docker load` 输出，区分构建、Artifact 下载、SSH 传输与服务器解包耗时。生产部署继续串行执行，避免新提交中途取消正在进行的数据库迁移。

生产部署由 `.github/workflows/deploy.yml` 在 GitHub Runner 构建镜像，再通过 SSH 上传到服务器。GHCR/TCR 不参与部署，也不需要为本工作流配置注册表登录凭据。若需要给其他环境共享或长期保存镜像，可以另行发布到镜像仓库，但这不会影响当前服务器部署。

旧版本工作流曾使用注册表构建并推送，再由服务器拉取；当前工作流已改为 SSH 传输，避免生产服务器访问跨境镜像服务。

#### 可选：发布镜像到同地域仓库

如果还需要给其他机器共享镜像，可以在 TCR/ACR 控制台创建命名空间和 `job-match` 仓库，并创建只具备该仓库推送/拉取权限的服务账号或访问凭证。该仓库不参与本项目的服务器部署；部署仍通过 SSH 上传归档。注册表域名必须从控制台复制，不能填写 `https://` 或仓库路径。

在服务器上先验证凭据和网络：

```bash
# 腾讯云 TCR 示例；企业版域名以控制台显示的实例域名为准
printf '%s' '<TCR密码或临时Token>' | docker login ccr.ccs.tencentyun.com \
  --username '<TCR用户名>' --password-stdin
docker pull ccr.ccs.tencentyun.com/<命名空间>/job-match/backend:<已有标签>

# 阿里云 ACR 示例；杭州个人版/企业版只是示例，地域和实例名按控制台替换
printf '%s' '<ACR Registry密码>' | docker login \
  <实例名>-registry.cn-hangzhou.cr.aliyuncs.com \
  --username '<ACR访问凭证用户名>' --password-stdin
docker pull <实例名>-registry.cn-hangzhou.cr.aliyuncs.com/<命名空间>/job-match/backend:<已有标签>
```

上述命令只用于手动验证或其他环境拉取。当前 `deploy.yml` 不读取这些注册表变量，也不会让生产服务器从该仓库拉取镜像。

#### 给远程 Docker daemon 配置代理

如果暂时不能使用同地域 Registry，需要在**生产服务器上**配置一个服务器可访问的 HTTP 代理。`127.0.0.1:7890` 只有在代理程序运行于生产服务器本机时才有效，本地电脑上的代理地址不会被 SSH 传递给 Docker daemon。

以 systemd 管理的 Docker Engine 为例：

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://<代理主机>:<端口>"
Environment="HTTPS_PROXY=http://<代理主机>:<端口>"
Environment="NO_PROXY=localhost,127.0.0.1,.local"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl show --property=Environment docker
```

验证代理确实作用于 daemon，而不是只作用于当前 shell：

```bash
curl -I https://ghcr.io/v2/
curl -I https://pkg-containers.githubusercontent.com/
docker pull ghcr.io/qiugu/job-match/backend:<标签>
```

Docker daemon 代理变更会重启 Docker 服务，建议在维护窗口执行。若服务器在云厂商 VPC 内，优先使用同地域 Registry；代理只作为 GHCR 仍需保留时的网络方案。

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

### 注册码与积分（credits）

注册账号必须提供注册码（`POST /api/auth/register` 的 `code` 字段）：

- 每个注册码带**过期时间**和**授予的积分**（默认 50 积分，JD 简历匹配与话术生成共享同一余额，可用 `REGISTRATION_DEFAULT_CREDITS` 调整）；
- 用该码注册的账号获得对应的积分余额——JD 简历匹配每次消耗 5 积分（`RESUME_MATCH_COST`）、JD 话术生成/重生成每次消耗 1 积分（`COVER_LETTER_COST`），调用 LLM **之前**原子预扣、失败自动归还，即只在真正产出结果时才消耗；
- 积分用完后消耗型接口返回 403「积分不足」；
- 管理员账号（初始账号）不受限制：`credits = -1` 表示无限。

发放注册码：官网「常见问题 → 使用需要登录吗」提供**自助领取**入口
（`GET/POST /api/auth/registration-code`），是注册码唯一的发放渠道：

- 每日限量 `REGISTRATION_DAILY_LIMIT`（默认 10 个），北京时间 0 点重置，
  每个网络每日限领 3 个；
- 领取的注册码有效期 `REGISTRATION_CODE_VALIDITY_DAYS`（默认 30 天），
  授予积分 `REGISTRATION_DEFAULT_CREDITS`（默认 50 积分）；
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
| `REGISTRATION_DEFAULT_CREDITS` | 注册码默认授予的积分（默认 50，JD 简历匹配与话术生成共享） |
| `RESUME_MATCH_COST` | 每次 JD 简历匹配消耗的积分（默认 5） |
| `COVER_LETTER_COST` | 每次 JD 话术生成/重生成消耗的积分（默认 1） |
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
| `d3e5f6a7b8c9`    | 配额改积分（credits）：`users.match_quota` → `users.credits`（非 admin 存量统一重置 50，admin `-1` 保留）；`registration_codes.grant_matches` → `grant_credits`（存量值保留） |

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
