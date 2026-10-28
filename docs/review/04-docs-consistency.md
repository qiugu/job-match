# 04 · 文档一致性与仓库卫生

> 评审对象：`AGENTS.md`、`README.md`、`docs/**`、`.gitignore`、工作区未跟踪产物
> 评审方式：文档声明逐条对照代码/文件系统实况
> 结论基准日：2026-10-27（HEAD `bc9b04c`）

## 结论

文档的**质量高、结构化程度超出多数同类项目**：`docs/ANALYTICS.md` 逐条给出了每一张图表的
计算口径并与代码实现一致（本次已核对 `job_status_events` 表结构与 `transition()` 唯一写入口，
与文档描述**完全相符**）；`docs/README.md` 定义了活跃/归档两层结构与「新增文档规则」。

问题因此不是「文档写得差」，而是**文档系统自身的维护机制有空转**：
`docs/README.md` 定的规则没有被自己执行（D1），`AGENTS.md` 落后于 `.env.example`（D2）。
仓库卫生侧则有一个值得注意的模式：`.gitignore` 用「按文件名前缀」而非「按扩展名」兜底（H1）。

---

## 问题清单

### D1 · `docs/README.md` 索引漏登记 7 项活跃文档（P2）

**证据** `docs/` 实际内容（`ls docs/`）：

| 实际存在 | 是否在 `docs/README.md` 索引中 |
| --- | --- |
| `BRAND.md` / `SEO.md` | ✅ 已登记 |
| `PLAN_llm_usage_ledger.md` / `PLAN_experience_memory.md` / `PLAN_feedback_module.md` | ✅ 已登记 |
| `FIX_editor_heading_rhythm.md` / `FIX_editor_align_scope.md` | ✅ 已登记 |
| `screenshots/` | ✅ 已登记 |
| **`DESIGN.md`** | ❌ 未登记 |
| **`ANALYTICS.md`** | ❌ 未登记 |
| **`PLAN_SEO.md`** | ❌ 未登记 |
| **`PLAN_delivery_analytics.md`** | ❌ 未登记 |
| **`M0.1_frontend_build_baseline.md`** | ❌ 未登记 |
| **`design-preview/`**（含 `index.html` 样张 + `shots/`） | ❌ 未登记 |
| **`superpowers/`** | ❌ 未登记 |

**根因** `docs/README.md` 自己写的「新增文档规则」第 1-2 条要求「新文档一律放 `docs/` 根并登记」，
但没有任何机制强制。而漏登记的恰好是**最重要的两份**：`DESIGN.md` 是视觉系统权威（项目记忆
明确记载「权威 `docs/DESIGN.md`」）、`ANALYTICS.md` 自称「权威口径文档」——权威文档不在索引里，
等于新人对着一份不完整的目录找规范。

**影响** 新人接手时最需要的两份文档不在入口；`docs/design-preview/` 是设计与实现的比对基准
（截图回归的参照物），不登记则无人知道它的用途。

**建议** 补齐索引表 7 行；把「文档新增」并入 CI 检查（`git diff --name-only` 命中 `docs/*.md`
但 `docs/README.md` 未变更时告警）。这是一条低成本、可自动化的规则。

---

### D2 · `AGENTS.md` 落后于 `.env.example` 12 个变量，且目录结构与实际不符（P2）

**证据 A（环境变量表）** 以下 12 个变量在 `.env.example` 与 `app/core/config.py` 中存在、
在 `AGENTS.md` 的环境变量表中**完全未提及**（`grep -c` 逐个确认为 0）：

```
LLM_TIMEOUT
MATCH_PIPELINE_VERSION
MATCH_TOTAL_TIMEOUT_SECONDS
MATCH_EXTRACT_TIMEOUT_SECONDS
MATCH_ANALYZE_TIMEOUT_SECONDS
MATCH_OPTIMIZE_TIMEOUT_SECONDS
MATCH_EXTRACT_MAX_TOKENS
MATCH_ANALYZE_MAX_TOKENS
MATCH_OPTIMIZE_MAX_TOKENS
REGISTRATION_DAILY_LIMIT
REGISTRATION_CODE_VALIDITY_DAYS
REGISTRATION_RESET_UTC_OFFSET
```

`AGENTS.md` 自身在「约定与最佳实践」里要求「文档内如涉及环境变量或命令变更，同步更新 `AGENTS.md`」
（`docs/README.md` 新增文档规则第 3 条同义），但 `MATCH_*` 这一整组匹配预算变量（`config.py:40-63`，
含一个 `model_validator` 继承逻辑）从未进入该表。

**证据 B（目录结构）** `AGENTS.md` 写 `app/api/ # 路由层（master.py, match.py ...）`，
实际 `app/api/` 无 `master.py`（详见分册 `01` 的 C3）。

**证据 C（默认值）** `AGENTS.md` 与 `.env.example` 均写 `AUTH_TOKEN_EXPIRE_MINUTES` 默认 10080，
`app/core/config.py:70` 实为 1440（详见分册 `01` 的 C1）。

**影响** 运维按 `AGENTS.md` 调参时会漏掉整组匹配超时预算；`MATCH_PIPELINE_VERSION` 缺失意味着
「legacy / combined 双链路」这个重要运行时开关在工程约定文档里不可见。

**建议** 环境变量表改为「从 `config.py` 生成」而非手写：一个 30 行的脚本把
`Settings.model_fields` 渲染成 Markdown 表格，CI 比对差异即可。手写表在 30+ 变量规模下必然漂移。

---

### H1 · `.gitignore` 用文件名前缀兜底，通用私钥扩展名未忽略（P2）

**证据** 根 `.gitignore`：

```
jdmatch.site*        # 按具体文件名前缀忽略
*.pem                # 按扩展名
...
nginx/certs/*.key    # 只对 nginx/certs/ 目录内的 .key 生效
nginx/certs/*.crt
```

**实测确认**：`jdmatch.site.key` / `jdmatch.site_bundle.pem` / `jdmatch.site.csr` **当前未被 git 跟踪**
（`git ls-files` 无匹配），`git log --all -- <path>` 无历史提交 —— 即**目前没有泄露**。

**但机制有缺口**：根目录下任何**不叫 `jdmatch.site*`** 的 `.key` 文件都不会被忽略
（通用 `*.key` 只对 `nginx/certs/` 生效）。实测 `git status` 已显示 `jobmatch.db-wal` /
`jobmatch.db-shm` 为未跟踪（`.gitignore` 只有 `*.db`）—— 说明「按精确名匹配」的缺口已经在
另一类文件上**实际发生**了。

**建议** 把 `*.key` 提升为全局规则（并保留 `nginx/certs/*.key` 作为冗余），补 `*.db-wal` / `*.db-shm`。
更稳的做法是在 CI 加一条 `git ls-files | grep -E '\.(key|pem|p12)$'` 断言为空。

---

### H2 · 工作区残留未跟踪产物（P2）

**证据** `git status --porcelain`（本次实测）：

```
?? .playwright-cli/
?? .probe-app/
?? after-reg.yaml      ?? auth.yaml      ?? landing.yaml
?? login2.yaml         ?? reg.yaml
?? frontend/.build-verify5/
?? frontend/.probe-panel/
?? jobmatch.db-shm     ?? jobmatch.db-wal
?? docs/design-preview/shots/2026-10-2{6,7}-*.png   （9 张）
```

**判断**：`.probe-app/` 与 `frontend/.probe-panel/` 是调试脚手架（注意 `.probe-app/migrations/`
是 `migrations/` 的**完整副本**，含 24 个迁移文件）；5 个 `*.yaml` 是 Playwright 快照残留；
`docs/design-preview/shots/*.png` 是设计比对截图（有其价值，但未归档）。

**影响** ① 仓库根散落调试副本，`rg` 搜索会命中两份 `migrations/`，本次评审中已实际造成干扰
（检索 `n7h9j1k3m5p7` 时命中了 `.probe-app/` 的重复副本）；② `jobmatch.db-wal/-shm` 未忽略，
存在被误提交的风险（含真实业务数据）。

**建议** `.gitignore` 补 `.probe-app/` `.build-verify*/` `*-panel/` `*.db-wal` `*.db-shm` `/[a-z]*-reg.yaml`；
截图目录建议归入 `docs/design-preview/shots/` 并纳入版本管理（它们是设计回归的证据）或整体忽略，
二者选一，不要停留在「未跟踪」状态。

---

## 文档准确性抽查（正面结论，供交叉验证）

为避免本册读起来像「全是漂移」，以下是**逐条核对后确认准确**的文档声明：

| 文档声明 | 核对结果 |
| --- | --- |
| `ANALYTICS.md` §1.3「唯一状态写入口 `transition()`，不允许 `job.status = ...` 直写」 | ✅ 全库仅 `services/job.py:160` 一处赋值，就在 `transition()` 内 |
| `ANALYTICS.md` §1.2 `job_status_events` 的 `source` 取值 `create/auto/manual/reopen/backfill` | ✅ 与 `services/job.py` 的 `EVENT_SOURCE_*` 常量一致 |
| `AGENTS.md`「API 统一 `/api` 前缀」 | ✅ 除 `/health`（设计内）外全部带前缀 |
| `AGENTS.md`「`uv.lock` 需提交」/ 前端 `pnpm-lock.yaml` | ✅ 两者均被跟踪 |
| `AGENTS.md`「改标只改 `public/logo.svg` 后跑 `pnpm generate:brand-icons`」 | ✅ `package.json` 存在该脚本 |
| `AGENTS.md`「`pnpm generate:sitemap` / `generate:assets`」 | ✅ 命令存在 |
| `AGENTS.md`「迁移必须走 Alembic，启动自动 `upgrade head`」 | ✅ `Dockerfile:97` 的 CMD 含 `alembic upgrade head` |
| `docs/README.md`「`docs/archive/` 存放已完成规划」 | ✅ 3 份 PLAN 已归档（job_tracking / feature_separation / resume_backend_source） |

## 验收标准（可执行）

```bash
# D1：索引完整性（docs 根下每个 .md 都应出现在 README.md 中，README.md 自身除外）
cd docs && for f in *.md; do [ "$f" = "README.md" ] || grep -q "$f" README.md || echo "未登记: $f"; done
# 期望无输出

# D2：AGENTS.md 覆盖 config.py 全部变量
.venv/bin/python -c "
from app.core.config import Settings
import re, pathlib
agents = pathlib.Path('AGENTS.md').read_text(encoding='utf-8')
missing = [n.upper() for n in Settings.model_fields if n.upper() not in agents]
print('未覆盖:', missing)
"
# 期望：未覆盖: []

# H1：无凭据被跟踪
git ls-files | grep -E '\.(key|pem|p12)$' ; echo "exit=$?"     # 期望 exit=1（无匹配）

# H2：脏文件已收敛
git status --porcelain | grep -vE '^\?\? docs/design-preview/shots/'   # 期望无输出或仅剩截图
```
