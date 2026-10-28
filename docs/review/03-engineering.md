# 03 · 工程设施与交付链路

> 评审对象：根目录元文件、`.github/`、`Dockerfile`、`docker-compose.yml`、`nginx/`、`pyproject.toml`、`tests/`
> 评审方式：只读通读 + 实测（`pytest` / `vitest` 实跑）
> 结论基准日：2026-10-27（HEAD `bc9b04c`）

## 结论

测试资产比预期丰厚（后端 34 个文件 / 233 例，前端 24 个文件 / 167 例），**但没有任何自动化门禁
去执行它们** —— 这套测试目前的唯一作用是人手动跑。这是本册的核心判断：问题不是「没有测试」，
而是「测试不产生约束」。

实测结果（本次评审真实执行）：

| 套件 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 后端 | `.venv/bin/python -m pytest -q` | **232 passed / 1 failed** | 69s |
| 前端 | `npx vitest run` | **167 passed / 24 files** | 58s |

那 1 例失败不是偶发，而是**设计上必然失败**（E1）。

---

## 问题清单

### E1 · 迁移测试硬编码 head 常量，新增迁移后必然失败（P1）

**实测输出**

```
FAILED tests/test_job_unique_migration.py::test_job_uniqueness_migration_reparents_associated_records
E  AssertionError: assert ('f6a8c0e2d4b7',) == ('n7h9j1k3m5p7',)
tests/test_job_unique_migration.py:89
1 failed, 232 passed, 7 warnings in 69.37s
```

**证据** `tests/test_job_unique_migration.py:14-15`：

```python
PREVIOUS_HEAD = "l5f7a9c2d4e6"
NEW_HEAD = "n7h9j1k3m5p7"
```

而 `migrations/versions/f6a8c0e2d4b7_add_growth_events.py:10` 写着
`down_revision = "n7h9j1k3m5p7"` —— 即 `n7h9j1k3m5p7` 之后又加了 `f6a8c0e2d4b7`，
真正的 head 已前移，测试里的常量留在原地。

**根因** 用字面量断言「迁移终点」。迁移链每前进一步，这个断言就必然失败一次。

**影响** 三点：① 测试基线是红的，任何人无法用「跑一遍测试」判断自己的改动是否引入回归
（红灯常态化的直接后果）；② 失败信息看起来像「迁移没生效」，容易误导排查方向；
③ 顺着这个红灯去「修」，最自然的做法是把常量改成新 head —— 下次再加迁移又坏一次。

**建议** 用 Alembic 自己的 API 取 head，而不是硬编码：

```python
from alembic.script import ScriptDirectory
from alembic.config import Config

def _head() -> str:
    script = ScriptDirectory.from_config(Config("alembic.ini"))
    return script.get_current_head()
```

同时把「数据重挂载」的断言与「head 是否到位」的断言拆成两个测试 —— 前者才是这个文件
真正要守的东西，前者本次是**通过**的。

> **✅ 已修复（2026-10-27）**：测试改为用 `ScriptDirectory` 动态取 `_current_head()` / `_previous_head()`，
> 并把 `test_job_uniqueness_migration_*`（重挂载断言）与 `test_migration_head_reachable`（head 到位断言）拆成两个用例。
> 现 `pytest` 237 passed / 0 failed。

---

### E2 · 无 CI 质量门禁（P1）

> **状态：已修复（P1）**。新增 `.github/workflows/ci.yml`：后端 `uv run pytest` + 前端 `pnpm test`（vitest）为硬门禁；`pnpm lint` 与 `pnpm typecheck` 首期 `continue-on-error: true` 收集存量（lint 基线 234 problems、typecheck 25 errors，均非本次引入）。

**证据** `ls .github/workflows/` → 只有 `deploy.yml`。该文件内不含 `lint` / `typecheck` / `pytest` / `vitest`
的任何调用（`Grep` 命中为 0，仅命中了 `.pytest_cache` 的排除项）。

**影响** 这是 E1 的同源问题：所有质量信号都依赖「人主动去跑」。结合 A4（无 `lint` 脚本）、
A2（类型检查范围不全），实际状态是：**主分支可以让红测试、类型错误、lint 违规长期共存而无感知**。

**建议** 新增 `.github/workflows/ci.yml`，最小三步：`uv run pytest` / `pnpm test` / `pnpm typecheck`。
先以 `continue-on-error: true` 上线一周收集存量问题，再转硬门禁 —— 否则第一天就会因 E1 而全红。

---

### E3 · 后端镜像以 root 运行且无 HEALTHCHECK（P2）

**证据**

```
Dockerfile:8:   FROM python:3.12-slim
Dockerfile:97:  CMD ["sh", "-c", "python -m alembic upgrade head && uvicorn ..."]
（全文 98 行，无 USER、无 HEALTHCHECK）
```

**对照证据** `frontend/Dockerfile:42-61` **有** `USER nodeapp` 与多阶段构建 —— 说明团队知道怎么做，
只是后端没做。这不是「不认识最佳实践」，是「只在前端做了」。

**影响** 容器逃逸场景下以 uid 0 运行，危害放大；库镜像层没有自检能力，编排层只能依赖
compose 的 healthcheck（`docker-compose.yml` 有配），单独 `docker run` 时无保护。

**建议** 加 `RUN useradd -u 10001 -m appuser` + `USER appuser`（注意 `data/` 卷权限），
以及 `HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8005/health')"`。

---

### E4 · `.dockerignore` 未排除证书私钥与文档（P2）

**证据** 根 `.dockerignore`（23 行）排除项为
`Dockerfile / .dockerignore* / .env* / *.db / *.db.bak.* / .venv / __pycache__ / *.pyc / .pytest_cache / .buildkit-cache / .git / .gitignore / migrations/versions/__pycache__ / frontend / tests / .codebuddy / backups`。

**未覆盖**（仓库根实际存在但会进入构建上下文）：

- `jdmatch.site.key`、`jdmatch.site_bundle.pem`、`jdmatch.site.csr`、`jdmatch.site_bundle.crt` —— TLS 私钥；
- `docs/`（含 62 张 png、29 个 md）、`shots/`、`jobmatch.db-wal` / `jobmatch.db-shm`。

**影响** 私钥被送进构建上下文（虽然最终 COPY 未选中，但它已离开宿主机进入 daemon；
若构建在远端 builder 上执行，等于把私钥上传）。文档与截图拖慢每次构建。

**建议** 补 `*.key` / `*.pem` / `*.csr` / `*.crt` / `docs` / `*.db-wal` / `*.db-shm` / `.playwright-cli` / `.probe-app`。

---

### E5 · 依赖版本约束无上界（P2）

**证据** `pyproject.toml:10-33` —— 22 条依赖全部是 `>=` 形式（`fastapi>=0.110`、`langchain>=0.2`、
`langgraph>=0.2`、`sqlalchemy>=2.0` …），无一条有 `<` 上界。

**已确认缓解**：`uv.lock` 被 git 跟踪，`uv sync` 会按锁文件安装，可复现。因此这是「潜在」而非
「现存」问题：一旦有人执行 `uv lock --upgrade` 或锁文件被删除/失效，就会拉到 breaking change。
`langchain` / `langgraph` 这类 0.x 版本库的次版本号不保证兼容，风险显著高于常规库。

**建议** 至少给 `langchain*` / `langgraph` 加上界（如 `langchain>=0.2,<0.4`），其余依赖保持 `>=`
并依赖锁文件。这是「锁文件 + 上界」的组合策略，社区对 0.x 依赖的常见做法。

---

### E6 · Nginx 缺 Content-Security-Policy（P2）

**证据** `nginx/nginx.ssl.conf:90-93` 已有 HSTS / `X-Content-Type-Options` / `X-Frame-Options` /
`Referrer-Policy`，**无** `Content-Security-Policy`（`Grep "Content-Security-Policy"` → 0 命中）。

**影响** CSP 是 S1/S2 那类注入缺陷的**最后一道**（也是唯一一道不依赖代码正确性的）防线。
当前缺位意味着一旦注入发生，浏览器会无条件执行。

**建议** 先以 `Content-Security-Policy-Report-Only` 上线收集违规（Vite 产物含内联
`__vite__css`、可能有内联 style，直接上强制策略大概率打挂页面），稳定后转强制。
最低限度先加 `object-src 'none'; base-uri 'self'`。

---

## 整改路线图

**两条硬规则**（顺序不可调）：

1. **测试基线必须先绿** —— 后续任何结构性改造（S3 计费、S5 Cookie、A1 拆组件）都需要回归保护。
   当前基线是红的（E1），所以第一步只能是 E1。
2. **耦合项必须同批** —— `lint` 脚本（A4）与 CI 门禁（E2）同批；`typecheck` 与 `tsconfig include`
   扩容（A2）同批。分两次做会出现「改了 A 却因为 B 没做而无法验证」。

| 阶段 | 内容 | 前置 | 完成判据 |
| --- | --- | --- | --- |
| P0 | E1 修绿 | 无 | `pytest` 0 failed |
| P1 | E2 + A4 + A2 同批上线 CI | P0 | CI 三步全绿 |
| P2 | E3 / E4 / E6 容器与网关加固 | P1 | 镜像 `USER` 非 root、构建上下文无密钥 |
| P3 | E5 依赖上界 | P1 | `uv lock` 后仍可安装 |
| P4 | 业务整改（S1-S7、C1-C2） | P1 | 见各分册验收标准 |

## 验收标准（可执行）

```bash
# E1：测试基线全绿
.venv/bin/python -m pytest -q --basetemp=.pytest-tmp        # 期望 0 failed

# E2：CI 存在且含三步
rg -n "pytest|vitest|tsc --noEmit" .github/workflows/       # 期望各 >= 1

# E3：镜像非 root
grep -c "^USER " Dockerfile                                  # 期望 1（当前 0）

# E4：构建上下文不含密钥
grep -E "\*\.key|\*\.pem|\*\.csr" .dockerignore              # 期望 3 行命中

# E6：CSP 存在
grep -c "Content-Security-Policy" nginx/nginx.ssl.conf       # 期望 >= 1

# E5：0.x 依赖有上界
rg -n "langchain|langgraph" pyproject.toml | rg ","          # 期望至少 2 行含上界
```
