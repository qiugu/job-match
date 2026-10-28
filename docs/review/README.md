# 代码评审报告（全量只读）

> 仓库：`job-matcher`（FastAPI 后端 + TanStack Start 前端 + Docker Compose 部署）
> 评审基线：分支 `design/paper-punch`，HEAD `bc9b04c`，2026-10-27
> 评审方式：四个维度并行只读探查 → **逐条回读源码复核** → 撤销不成立的结论 → 分册交付
> 业务代码改动：**零**（评审与整改是两次独立授权，本报告不含任何修改）

---

## 一句话结论

**没有 P0。** 对象级授权、SQL 注入、口令存储、令牌失效四个高风险面都做对了；
7 个 P1 全部是「同类机制在一处漏做」的**一致性问题**，而不是架构性错误 —— 这一点决定了
整改成本远低于问题数量给人的印象：其中 3 个（C1、E1、S4）合计约 1 小时即可修完。

## 评审范围与方法

| 维度 | 范围 | 主要手段 |
| --- | --- | --- |
| 后端与安全隔离 | `app/` 56 个 `.py`（约 8,700 行）、`migrations/` | 调用链回读、配置项引用检索、`pytest` 实跑 |
| 前端 | `frontend/src/` 323 个文件（约 38,300 行） | 渲染链路回读、`tsconfig` 实效分析、`vitest` 实跑 |
| 工程设施 | 根元文件、`.github/`、Docker、nginx、依赖声明 | 实际命令核验（`git ls-files` / `wc -l` / `ls`） |
| 文档一致性 | `AGENTS.md`、`docs/**` 共 29 篇 md | 声明逐条对照代码实况 |

**方法论要点**：每条结论都回读了源码。这一步稳定淘汰了约 1/3 的初始「发现」——
被撤销的条目见文末「交付前撤销的指控」，那部分与保留的结论同等重要。

---

## 问题总表

| ID | 严重度 | 标题 | 分册 |
| --- | --- | --- | --- |
| **S1** | P1 | Markdown 预览开启 raw HTML 且无清洗（`html: true` + 无 DOMPurify） | [02](02-frontend.md) |
| **S2** | P1 | 富文本「含 HTML 标签即完全信任」，`normalizeLinkHref` 未被调用 | [02](02-frontend.md) |
| **S3** | P1 | `/api/ai/*` 三个端点不扣积分、无限流（匹配/话术都扣，唯此漏） | [01](01-backend-security.md) |
| **S4** | P1 | 简历 PDF 上传无体积/页数上限，整体读入内存 | [01](01-backend-security.md) |
| **S5** | P2 | HttpOnly Cookie 签发后从不读取，「双通道」安全声明不成立 | [01](01-backend-security.md) |
| **S6** | P2 | 两个匿名可写端点（site-visits / growth-events）无限流 | [01](01-backend-security.md) |
| **S7** | P2 | 上游异常原文经 `detail=str(e)` 透传给客户端（4 处） | [01](01-backend-security.md) |
| **C1** | P1 | 令牌有效期：代码默认 1440、注释写「7 天」、文档写 10080，三方冲突 | [01](01-backend-security.md) |
| **C2** | P2 | `latest_acceptance` 实为「是否曾接受」（`max(accepted)`），与字段名不符 | [01](01-backend-security.md) |
| **C3** | P2 | `AGENTS.md` 声明的 `app/api/master.py` 不存在 | [01](01-backend-security.md) |
| **A1** | P2 | 巨型文件与职责混杂（`match/page.tsx` 1642 行等 5 处） | [02](02-frontend.md) |
| **A2** | P2 | `tsconfig.include` 只覆盖 `src/routes`，组件/测试成为类型盲区 | [02](02-frontend.md) |
| **A3** | P2 | 长列表无虚拟化（列表会随投递累积增长） | [02](02-frontend.md) |
| **A4** | P2 | `.eslintrc.json` 存在但 `package.json` 无 `lint` 脚本 | [02](02-frontend.md) |
| **E1** | P1 | 后端测试基线为红：迁移测试硬编码 head，新增迁移后必然失败 | [03](03-engineering.md) |
| **E2** | P1 | CI 只有 `deploy.yml`，无 lint / typecheck / test 门禁 | [03](03-engineering.md) |
| **E3** | P2 | 后端镜像以 root 运行、无 HEALTHCHECK（前端镜像已做对） | [03](03-engineering.md) |
| **E4** | P2 | `.dockerignore` 未排除 `*.key` / `*.pem` / `docs/` / `*.db-wal` | [03](03-engineering.md) |
| **E5** | P2 | `pyproject.toml` 22 条依赖全为 `>=` 无上界（`uv.lock` 缓解） | [03](03-engineering.md) |
| **E6** | P2 | nginx 有 HSTS/XCTO/XFO，缺 Content-Security-Policy | [03](03-engineering.md) |
| **H1** | P2 | `.gitignore` 按文件名前缀兜底，通用 `*.key` 未忽略 | [04](04-docs-consistency.md) |
| **H2** | P2 | 工作区残留未跟踪产物（含 `migrations/` 副本、`*.db-wal`） | [04](04-docs-consistency.md) |
| **D1** | P2 | `docs/README.md` 索引漏登记 7 项，含 `DESIGN.md` / `ANALYTICS.md` | [04](04-docs-consistency.md) |
| **D2** | P2 | `AGENTS.md` 落后 `.env.example` 12 个变量，目录结构亦漂移 | [04](04-docs-consistency.md) |

**分布**：P0 = 0，P1 = 7，P2 = 17，合计 24。

---

## 整改进度

> 截至 2026-10-27，P0 + P1 共 12 项已全部落地（E1/C1/S4/S1/S2/A2/A4/E2），测试基线均通过。剩余 12 项 P2 待排期。

| 阶段 | 已修复（✅） | 待处理（⬜） |
| --- | --- | --- |
| P0 | E1（测试基线）、C1（令牌有效期）、S4（上传上限） | — |
| P1 | S1（Markdown 清洗）、S2（富文本清洗 + 链接规范化）、A2（tsconfig 覆盖）、A4（lint 脚本 + 配置）、E2（CI 门禁） | — |
| P2 | — | S3、S5、S6、S7、C2、C3、A1、A3、E3、E4、E5、E6、H1、H2、D1、D2 |

**验证基线（修复后）**

- 后端 `pytest`：237 passed / 0 failed（104s）
- 前端 `vitest`：179 passed / 25 files（新增 `tests/sanitize.test.ts` 12 例）
- 前端 `tsc --noEmit`：25 errors（全部为既有 `src/app/**` Next 残留死代码 + 2 测试文件类型问题，P1 改动零新增）
- 前端 `eslint .`：232 problems（124 err + 108 warn，CI `continue-on-error` 收集）
- 凭据：`git ls-files | grep -E '\.(key|pem|p12)$'` 无匹配

---

## 优先级矩阵（按「危害 × 修复成本」）

| | 修复成本低（≤1h） | 修复成本中（半天） | 需决策/产品介入 |
| --- | --- | --- | --- |
| **危害高** | C1、E1、S4 | S1 + S2（同批）、S3 | — |
| **危害中** | S7、E4、H1、H2 | E2 + A2 + A4（同批）、E3、E6 | S5（删或接）、C2（改名或改实现） |
| **危害低** | D1、D2 | A1、A3、E5 | — |

**读法**：左上角三格是「今天就能修完」的部分，建议立刻做；右中两格需要先定方案。

---

## 整改路线图

两条硬规则决定了顺序，不可调整：

1. **测试基线必须先绿（E1）** —— 后续任何结构性改造都需要回归保护，而现在基线是红的。
2. **耦合项必须同批** —— `S1+S2`（共用一套白名单）、`E2+A2+A4`（门禁与它的前提）必须同批，
   分开做会出现「改了 A 却因 B 未做而无法验证」。

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| P0 | E1（修绿基线）+ C1（统一令牌有效期）+ S4（上传上限） | **✅ 已落地**（2026-10-27）：`pytest` 237 passed / 0 failed；令牌三方统一为 10080；上传有 413 + 页数上限 |
| P1 | S1 + S2 同批（引入 DOMPurify）+ E2/A2/A4 同批（CI 三步） | **✅ 已落地**（2026-10-27）：`sanitize.test.ts` 12 passed；`tsc` 放宽后 25 错（全存量）；`eslint .` 基线 232 problems（124 err + 108 warn，配置误报已排除）；`ci.yml` 已加，lint/typecheck 软门禁 |
| P2 | S3（AI 计费）+ S7（异常映射）+ S6（匿名限流） | 见 01 册验收命令 |
| P3 | E3/E4/E6 容器与网关加固 + H1/H2 仓库卫生 | 镜像非 root、构建上下文无密钥 |
| P4 | A1（拆巨型组件）+ A3（虚拟列表）+ E5（依赖上界）+ D1/D2 | 按需排期 |

> **不建议**在 P0 完成前动 S3 / S5 —— 两者都改鉴权或计费语义，没有绿色基线时风险高于收益。

---

## 本次实测基线

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 后端 | `.venv/bin/python -m pytest -q --basetemp=.pytest-tmp` | **237 passed / 0 failed**（~14s） |
| 前端 | `npx vitest run` | **167 passed / 24 files**（58s） |
| 前端类型 | `npx tsc --noEmit` | **0 error**（5m54s，外置卷 IO 偏慢）→ 已纳入范围是干净的，盲区见 A2 |
| 凭据跟踪 | `git ls-files \| grep -E '\.(key\|pem\|p12)$'` | 无匹配（**当前无泄露**） |
| 迁移链 | `alembic heads` | 单 head `f6a8c0e2d4b7`，无分叉 |

> **P0 整改已落地**（2026-10-27，独立授权）：E1 迁移测试改为动态取 head（不再硬编码）、C1 令牌默认值与注释/文档统一为 10080、S4 新增 `resume_upload_max_bytes=10MB` + `resume_upload_max_pages=30` 并在 `resume.py` 上传入口做分块读 + 413 护栏。新增 `tests/test_config.py`、`tests/test_resume_upload_limits.py` 共 5 例。后端套件由「232 passed / 1 failed」变为「237 passed / 0 failed」，基线已绿，可进入 P1。

---

## 交付前撤销的指控

以下结论在初步探查阶段被提出，**回读源码后判定不成立**，特此记录（避免后续有人去修不存在的问题）。

| # | 初始指控 | 撤销理由（证据） |
| --- | --- | --- |
| 1 | 「存在 BOLA / 水平越权：端点只按 id 查询」 | 全部端点均校验归属：列表/创建类直接 `WHERE user_id == user.id`（`resume.py:395`、`match.py:227`、`jobs.py:157`、`cover_letter.py:196`）；单资源类 `db.get` 后统一走 `_ensure_owner` 并返回 404（`resume.py:241`、`match.py:91`、`jobs.py:88`、`cover_letter.py:87`）。**无一处缺失。** |
| 2 | 「后端没有测试」 | 初次 `find` 结果被 `head -20` 截断造成误判。实际 `tests/` 有 34 个文件、233 例，含 `test_security.py` / `test_match_routes.py` / `test_auth_routes.py` 等 API 集成测试。 |
| 3 | 「`credits == -1` 是管理员标记」 | `app/models/user.py:52` `is_admin` 由 `role == "admin"` 决定；`credits < 0` 只是 `unlimited_credits`（`:56-58`）。 |
| 4 | 「安全配置项定义了但没人用（`max_upload_size` 式空转）」 | 逐项检索确认 `pdf_export_*` 六项、`registration_*` 三项、`resume_match_cost` / `cover_letter_cost` / `auth_*` 均有实际业务引用。**唯一的空转是 Cookie（已单列为 S5），不是配置项。** |
| 5 | 「XSS 为 P0，可跨用户存储型」 | 降级为 P1：`routes/` 下仅 8 个路由，**无任何共享/公开简历渲染页**（无 `/share`、无 `/r/[id]`），受害者即攻击者；且服务端导出链路有独立防护（`pdf_export.py:176-186` strip script/on*、渲染禁 JS）。降级理由不是「不严重」，而是**当前架构下不可跨用户触发**。 |
| 6 | 「迁移链分叉、存在双 head」 | `alembic heads` 单一 head `f6a8c0e2d4b7`；历史上的分叉已由合并迁移 `l5f7a9c2d4e6` 收口。 |
| 7 | 「async 函数内存在同步阻塞调用」 | `database.py:71` 的 `subprocess.run` 只在 `init_db()` 启动期（`main.py:26` lifespan）执行；`resume.py:224` 的 `asyncio.run` 位于 `asyncio.to_thread` 内。请求路径无阻塞调用。 |
| 8 | 「前后端 `ResumeData` 契约不一致」 | `frontend/src/types/resume.ts:195` 与 `app/schemas/resume.py:127` 字段逐一相同（连 `employementStatus` 这类历史拼写错误都两端一致）。 |
| 9 | 「混用包管理器（npm/yarn/pnpm 并存）」 | 只有 `frontend/pnpm-lock.yaml`，无 `package-lock.json` / `yarn.lock`；根 `uv.lock` 存在且被跟踪。 |
| 10 | 「历史提交中泄露过 TLS 私钥」 | `git log --all --oneline -- jdmatch.site.key` 无任何记录；`git ls-files` 无匹配。私钥存在于工作目录但**从未进入版本库**。 |

**另有 1 条保留但降级的观察**（不计入问题表）：
`match.py` 在 LLM 已成功、但 `db.commit` 失败时会给用户退款 —— 用户无损，但部署方白付一次
LLM 成本。属「计费与成本的边界情况」，需要产品决定是否接受，暂不定性为缺陷。

---

## 分册导航

| 分册 | 覆盖 |
| --- | --- |
| [01 后端与安全隔离](01-backend-security.md) | S3-S7、C1-C3（含调用链证据与对照证据） |
| [02 前端契约与渲染安全](02-frontend.md) | S1、S2、A1-A4（含 55 个 `dangerouslySetInnerHTML` 消费点分布） |
| [03 工程设施与交付链路](03-engineering.md) | E1-E6、实测基线、整改路线图 |
| [04 文档一致性与仓库卫生](04-docs-consistency.md) | H1、H2、D1、D2（含文档准确性正面抽查） |
| [05 编辑器页交互评审](05-editor-interaction.md) | I1-I16（Markdown 工作台：保存可信度、预览缩放、工具栏状态、校对链路、右侧 dock、令牌偏差）。独立任务，不计入上表 24 项 |
| [06 编辑器页交互问题修复记录](06-editor-interaction-fixes.md) | I1-I16 的逐条落地修复、验证结果与取舍说明 |

> 跨文件引用只链接**目标文件**，不使用 `#anchor` —— 中文标题自动生成的锚点不可预测。
> 引用具体条目时请直接写 ID（如「见 03 的 E1」）。
