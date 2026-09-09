# 岗位卡（Job Tracking）与求职漏斗交互 — 可实施方案

> 目标：把「简历匹配 + 话术匹配」从**任务记录**升级为**以岗位为中心的机会管理**。
> 用户先按 JD 生成打招呼话术（轻操作），等招聘方回复后再回到同一岗位定制简历（重操作）；
> 所有话术/匹配产出自动挂到「岗位卡」下，刷新、换 JD、跨天回访都不丢上下文。

> 前置：功能分离（话术独立为资源）已完成并上线。本方案在其之上叠加岗位实体，不改动既有话术/匹配的 CRUD 语义。

---

## 一、现状问题诊断

| # | 缺口 | 现状 | 后果 |
|---|------|------|------|
| 1 | 缺岗位实体 | 只有 `cover_letters`、`derived_resumes` 两张平铺表 | 无法表达「一个 JD 的多条话术 + 多次匹配」的归属关系 |
| 2 | 等待中的机会没有"家" | 话术列表平铺，`jd_text` 冗余重复 | 首次打招呼未获回复后转投下一个 JD，旧上下文难以回流；对方回复时找不到入口 |
| 3 | 入口与真实时序不符 | `TaskModePicker` 三入口平级，无默认路径 | 用户在信息最少时被迫做资源决策；海投期每个 JD 都跑重匹配（2 分钟 + 额度）浪费大 |
| 4 | 结果区无下一步引导 | 话术生成后流程即止 | 「对方要简历了 → 回同一 JD 定制简历」的漏斗衔接要靠用户自己重新配置 |
| 5 | 重复 JD 无防御 | 同一 JD 可反复粘贴 | 同一岗位生成多份相互孤立的话术/匹配记录 |
| 6 | 状态无表达 | 无任何"待回复/已投递"语义 | 用户跨天回访靠记忆，跟进时机靠猜 |

---

## 二、设计目标

1. **岗位即容器**：新增 `jobs` 表作为父实体，话术与匹配结果通过可空外键归属岗位；老数据保留不迁移即不破坏。
2. **自动建档、无感保存**：生成话术/匹配时自动 find-or-create 岗位卡，用户永不需要手动"保存"。
3. **回流低摩擦**：岗位列表一键恢复 JD 上下文，从「打招呼」自然衔接到「定制简历」。
4. **状态自动为主、手动为辅**：生成打招呼 → 待回复；接受优化简历 → 已定制简历；其余手动标记。
5. **漏斗入口默认话术**：默认选中「打招呼话术」，重操作（匹配）留给有正反馈的岗位。

---

## 三、数据模型变更

### 3.1 新增 `jobs` 表（`app/models/job.py`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String(32) PK, uuid | 与既有表一致的 `_id()` 约定 |
| `user_id` | String(32), index | 归属用户（默认空串 = 无归属，与其余表一致） |
| `jd_text` | Text | **归一化后的 JD 原文**（创建时 trim + 折叠空白换行，供查重与快照） |
| `title` | String(255) | 岗位名，创建时取 jd 首行截断 40 字兜底，可 PATCH 改名 |
| `company` | String(255) default "" | 公司名，MVP 不自动提取，留空 + 可 PATCH |
| `status` | String(32) default `"greeting_sent"` | 见 3.4 状态机 |
| `created_at` / `updated_at` | DateTime | 与既有表一致（UTC, `_now`/`_id` 同款） |

### 3.2 既有表加可空外键（均 `ondelete="SET NULL"`）

| 表 | 新增列 | 语义 |
|----|--------|------|
| `cover_letters` | `job_id` String(32) **nullable** FK → jobs.id | 话术归属岗位；删岗位后置空（记录保留为"未归类"），**不级联删除**——话术是用户资产 |
| `derived_resumes` | `job_id` String(32) **nullable** FK → jobs.id | 匹配结果归属岗位，规则同上 |

> **删除语义（两级，2026-09-09 修正）**：删卡动作实际混了两种意图——「整理列表」与「彻底抹除」，默认按整理处理、危险操作显式提供：
> - `DELETE /api/jobs/{id}`（默认）——仅删卡片，子记录 `job_id` 置空为"未归类"，话术/匹配仍保留可查；
> - `DELETE /api/jobs/{id}?purge=true`（显式危险操作，前端需确认弹窗 + 影响数量清单）——级联删除该卡下全部话术与匹配记录；
>   **已接受（accepted）的优化简历在 `master_resumes` 中的副本不受影响**——那是独立资产（"我的简历"库），不由岗位分组裁决存亡。
>
> 默认不级联的根因：级联边界不干净。`derived_resumes` 接受后内容已复制进 `master_resumes`，"按岗位删除"若级联，边界会蔓延到用户简历库；且话术/匹配是不可再生的 LLM 产出，一次手滑「先清了再说」即永久丢失。

### 3.3 历史数据回填（一次性迁移）

按 `(user_id, 归一化 jd_text)` 分组既有 `cover_letters` 与 `derived_resumes`：

- 每组自动创建一张岗位卡，`title` 取 jd 首行截断；
- 该组的子记录 `job_id` 回填为该卡；
- 状态推导：组内存在 `accepted=True` 的衍生简历 → `resume_ready`；否则仅含衍生简历 → `replied`；只含话术 → `greeting_sent`。

> 归组粒度以 `cover_letters.jd_text` / `derived_resumes.jd_text` 的**归一化**文本相等为准（与 4.4 查重同一函数），避免空白差异分裂。

### 3.4 状态机（常量集中定义，建议 `app/models/job.py` 或 `app/core/constants.py`）

| 枚举值 | 中文 | 含义 | 如何进入 |
|--------|------|------|----------|
| `greeting_sent` | 已打招呼 · 待回复 | 默认态 | 自动：生成打招呼话术时建卡 |
| `replied` | 已回复 | 对方有回音 | 手动（一键标记） |
| `resume_ready` | 已定制简历 | 优化简历已被接受 | 自动：`accept_match` 成功 |
| `applied` | 已投递 | 已发出简历/进入流程 | 手动 |
| `closed` | 已结束 | 挂掉/放弃 | 手动 |

---

## 四、Schema（Pydantic）变更 — `app/schemas/agent.py`（或拆分 job schema）

| 改动 | 详情 |
|------|------|
| 新增 `JobSummary` | `id`、`title`、`company`、`status`、`jd_text`、`created_at`、`updated_at`、聚合字段（见下） |
| 新增 `JobDetail` | = `JobSummary` + 原文 `jd_text` 全文（列表页不下发全文省流量，详情页需要） |
| 新增 `JobUpdate` | `title?`、`company?`、`status?`（均可选，PATCH 语义） |
| 新增 `JobDetectRequest` | `jd_text: str` → 返回 `{ job_id: str \| null }` |
| `CoverLetterResult` **追加** `job_id: str \| None` | 前端据此归组/刷新岗位列表 |
| `DerivedResumeSummary` / `MatchResult` **追加** `job_id: str \| None` | 同上 |

聚合字段（列表页一次返回，避免 N+1）：
`cover_letter_count`、`derived_count`、`last_activity_at`（取该卡子记录最大 `created_at`，无则用 jobs.updated_at）、`latest_acceptance`（是否有 accepted 的衍生简历，前端决定徽章展示）。

---

## 五、API 设计（新增 `app/api/jobs.py`，前缀 `/api/jobs`）

| 方法 | 路径 | 说明 | 额度 |
|------|------|------|------|
| GET | `/api/jobs` | 当前用户岗位列表（含聚合，按 `last_activity_at` desc） | 无 |
| GET | `/api/jobs/{job_id}` | 岗位详情（含 jd_text 全文 + 聚合）；非本人 404 | 无 |
| POST | `/api/jobs` | 手动建档（罕见，供检测 UI 的"仍然新建"兜底） | 无 |
| PATCH | `/api/jobs/{job_id}` | 改 title/company/status；status 白名单校验 | 无 |
| DELETE | `/api/jobs/{job_id}` | **默认**：仅删卡片，子记录 job_id 置空（SET NULL）转"未归类"，资产保留 | 无 |
| DELETE | `/api/jobs/{job_id}?purge=true` | **彻底删除**：级联删除该卡下全部话术 + 匹配记录；已接受简历在 `master_resumes` 的副本不受影响（见 3.2） | 无 |
| POST | `/api/jobs/detect` | 按归一化 jd_text 查重 → `{job_id \| null}` | 无 |

> 子记录查询复用现有端点并追加过滤参数：`GET /api/cover-letters?job_id=`、`GET /api/match?derived...`（或 `derived_resumes` 列表端点）增加 `job_id` 可选过滤。避免新端点重复造轮子。

### 5.1 写入链路的自动挂载（核心改动）

**`POST /api/cover-letters`（create_cover_letter）** 与 **`POST /api/match`（create_match）** 共用同一逻辑（抽 `app/services/job.py` 的 `attach_or_create_job(db, user, jd_text) -> Job`）：

1. 归一化 `jd_text`（trim、折叠空白/换行）——建卡与查重都基于归一化文本；
2. 归一化文本命中该用户既有岗位卡 → 直接返回该卡（不新建）；
3. 未命中 → 建卡（`status=greeting_sent`，`title` 取 jd 首行截断 40 字），返回新卡；
4. 调用方把返回的 `job.id` 写入子记录 `job_id`，响应携带 `job_id`。

**`accept_match`**：接受成功后，若该衍生简历挂了 `job_id` 且岗位状态为 `greeting_sent` / `replied`，推进为 `resume_ready`。

> 归一化函数建议放 `app/services/job.py`，迁移回填与 detect 端点共用同一实现，保证语义一致。

---

## 六、前端调整

### 6.1 API 客户端与类型 — `frontend/src/lib/jobmatch.ts`

- 新增类型 `JobSummary / JobDetail / JobUpdate`、`CoverLetter.job_id`、`MatchResult.job_id`；
- 新增 `listJobs / getJob / updateJob / deleteJob / detectJob`；
- `listCoverLetters` 增加 `job_id` 过滤参数（对齐后端）。

### 6.2 岗位列表 + 上下文恢复（核心 UI）

- **入口**：匹配工作台左侧配置抽屉顶部新增「我的岗位」开关（列表抽屉/面板），与现有配置区并存；
- **卡片行**：`title`（空则显示 jd 首行截断）· 状态徽章（按 3.4 枚举映射中英文）· `cover_letter_count`/`derived_count` · `last_activity_at`（相对时间）；
- **点击恢复**：选中岗位 → 关闭列表 → JD 文本域回填 `job.jd_text` → 记录当前上下文 `jobId` → 结果区/话术面板按 `job_id` 过滤子记录；
- **继续动作**：卡片上「生成定制简历」→ 等价于切到匹配任务 + 自动带出该 JD 上下文；
- **空态**：无岗位卡时给一行说明「每次生成话术/匹配会自动建档」，不引导手动建卡。

### 6.3 生成后的回流衔接

- **话术生成/匹配完成后**：若本次新建了岗位卡，列表刷新；生成的封面响应 `job_id` 写入本地上下文；
- **仅话术模式**：结果区话术下方常驻一步引导（复用现有 toast/提示条组件）：
  > 「对方回复、要简历了？用这个 JD 生成定制简历 →（约 2 分钟 · 消耗 1 次）」
  点击 → 任务切到 match、携带同一 JD/简历上下文发起匹配（不重新让用户粘贴）；
- **重复 JD 防御**：JD 文本域失焦/提交时调 `detectJob`，命中则弹确认：「这个 JD 在 {时间} 打过招呼，继续这个机会？继续 / 仍然新建」。

### 6.4 入口漏斗化（`TaskModePicker` + 默认值）

- 卡片重排：`① 打招呼话术（默认选中）` → `② 定制简历` → `一次搞定（进阶）`；
- 新进入页面默认 `pitch`（现默认值待确认，若为 match/both 则改）；
- 卡片描述与成本标注不变，仅顺序/默认值/i18n 文案微调（`zh.json` / `en.json` 同步）。

### 6.5 状态维护与删除（轻量）

- 岗位卡操作菜单提供手动推进：标记已回复 / 已投递 / 已结束（closed = 归档，从活跃列表隐藏，可恢复）；
- 自动推进（5.1 accept）在响应后本地同步；
- **删除两档**（对应 3.2/5.x）：
  - 「删除岗位」= 解除分组（子记录转未归类）；
  - 「彻底删除」= 级联，走 `AlertDialog`：红色危险按钮 + **列出将删内容数量**（「将删除该岗位及其下 3 条话术、2 份匹配记录」）+ 不可撤销提示；若岗位下存在已接受简历，弹窗注明「已保存到『我的简历』的副本不受影响」。

> **非目标（V2，不在本期）**：跟进提醒定时（3 天未回复浮层）、LLM 自动提取 title/company、岗位漏斗统计看板、JD 草稿暂存（localStorage）。本期只做资产化闭环，避免范围膨胀。

---

## 七、实施步骤与优先级

> 前置检查（每次改库前必做）：`cp jobmatch.db jobmatch.db.bak.<ts>`。启动会自动 `alembic upgrade head`，先备份再重启。

### Phase 1 — 数据层（基础，先行）
1. 新增 `app/models/job.py`（含 `JOB_STATUSES` 常量 + `_normalize_jd` 占位）；
2. Alembic 迁移：建 `jobs` 表；`cover_letters` / `derived_resumes` 加可空 `job_id` FK（SET NULL）；
3. 回填脚本（一次性，可放迁移内或独立 `scripts/`）：按 `(user_id, 归一化 jd_text)` 归组建档回填；
4. **验证**：迁移在备份库副本上试跑；统计回填前后记录数、未归类残留数；`git diff` 无意外变更。

### Phase 2 — 后端服务与 API
5. `app/services/job.py`：`_normalize_jd`、`attach_or_create_job`、聚合查询函数；
6. `app/schemas/`：Job 系列 + `CoverLetterResult`/`MatchResult` 补 `job_id`；
7. `app/api/jobs.py` 五端点 + detect，注册进 `app/main.py`；
8. 改造 `app/api/cover_letter.py`（create）、`app/api/match.py`（create/accept）接入自动挂载与状态推进；
9. 既有 list 端点补 `job_id` 过滤参数；
10. **测试**：`tests/` 补 create 自动建档/查重复用/accept 状态推进/越权 404/删卡 SET NULL 用例。

### Phase 3 — 前端
11. `jobmatch.ts` 类型与客户端；
12. 岗位列表组件 + 状态徽章 + 上下文恢复（`components/match/JobListPanel.tsx` 或同级）；
13. JD 文本域 detect 重复提示；
14. 话术结果「生成定制简历」衔接动作；TaskModePicker 默认/顺序调整；i18n 双语同步。

### Phase 4 — 收尾验证
15. 全链路手测清单（见验收）；`npx tsc --noEmit` 过滤本批文件；`npx vite build --outDir /tmp/...` 编译验证；
16. 更新本计划「验证记录」与项目记忆。

---

## 八、风险与回退

| 风险 | 缓解 |
|------|------|
| 回填归组错误（不同 JD 因归一化撞车） | 归一化只折叠空白，不做语义近似；回填前在备份副本跑校验 SQL，检查"一组多 JD 原文"的组 |
| 迁移破坏既有数据 | 老库先备份；新列全部 nullable，迁移失败可 `downgrade` 无损回退（回填数据在 downgrade 前不删） |
| detect 误报（同 JD 不同版本想分开跟踪） | 提供「仍然新建」兜底；detect 只提示不拦截 |
| 列表 N+1 | 聚合字段单 SQL 子查询一次取回 |
| 与既有「话术/匹配按 derived 过滤」逻辑冲突 | 新过滤是叠加参数，不动旧行为；`job_id` 与 `derived_resume_id` 同时给时按 AND |
| purge 误触销毁资产 | purge 仅在确认弹窗（列数量清单）后触发；默认 DELETE 永不级联；已接受简历副本不受 purge 影响（见 3.2） |

---

## 九、验收标准

1. 老用户升级后：历史话术/匹配自动归入岗位卡，无"孤儿"新增（残留记录可接受但需统计报告）；
2. 生成打招呼话术 → 自动出卡 `已打招呼·待回复`；再贴同一 JD 生成 → **不新开卡**，话术挂同一卡；
3. 换 JD 生成 → 出现第二张卡；返回第一张卡 → JD 回填、该卡话术列表可见；
4. 对岗位 A 发起匹配 → 接受 → 卡状态自动变 `已定制简历`；手动可改为已投递/已结束；
5. 仅话术模式结果下方出现「生成定制简历」引导，点击后带同 JD 上下文直接进入匹配；
6. 删除两档行为正确：默认删除 → 卡片消失、话术/匹配转未归类仍在总列表可查；「彻底删除」确认弹窗列出数量，级联后话术/匹配一并消失，已接受简历在「我的简历」的副本仍在；
7. 双语 i18n 无缺失 key；小屏下列表可用（不追求新布局，抽屉化即可）。

---

## 十、验证记录

> 实施于 2026-09-09。后端（Phase 1+2）先行，前端（Phase 3）随后，均已落地。

### 改动文件清单

**后端（新增 / 修改）**
- `app/core/text_utils.py`（新增）— `normalize_jd_text`（折叠空白）。
- `app/models/job.py`（新增）— `Job` 模型 + `JOB_STATUSES` / `JOB_STATUS_DEFAULT` / `JOB_STATUS_RESUME_READY`。
- `app/services/job.py`（新增）— `attach_or_create_job`（归一化查重/建卡）、`detect_job`、`get_job_aggregates`、`_derive_title`。
- `app/schemas/job.py`（新增）— `JobSummary` / `JobDetail` / `JobUpdate` / `JobDetectResponse`。
- `app/api/jobs.py`（新增）— 七端点（list/get/post/patch/delete(?purge)/detect）+ `main.py` 注册。
- `app/api/cover_letter.py` — create 接入 `attach_or_create_job`；list 增加 `job_id` 过滤；`CoverLetterResult` 补 `job_id`；`_to_result` 带 `job_id`。
- `app/api/match.py` — create 挂载岗位卡并返回 `jobId`；list/detail 返回 `jobId`；accept 推进状态为 `resume_ready` 并返回 `jobId`/`jobStatus`。
- `app/models/cover_letter.py`、`app/models/derived_resume.py` — 加可空 `job_id` FK（SET NULL）。
- `app/schemas/agent.py` — `CoverLetterResult.job_id`、`MatchResult` 链路返回 `jobId`。
- `app/models/__init__.py`、`app/core/database.py` — 注册 `Job` 模型。
- `migrations/versions/g1b2c3d4e5f6_add_jobs_tracking.py`（新增）— 建 `jobs` 表、加 FK、注册 `norm_jd` SQL 函数、回填历史、状态推导。

**前端（新增 / 修改）**
- `frontend/src/lib/jobmatch.ts` — 新增 `JobStatus`/`JobSummary`/`JobDetail`/`JobUpdate`/`JobDetectResult` 类型；`CoverLetter.job_id`、`MatchResult.jobId`；`listJobs`/`getJob`/`updateJob`/`deleteJob`/`detectJob`；`listCoverLetters` 增加 `jobId` 过滤。
- `frontend/src/components/match/JobListPanel.tsx`（新增）— 岗位列表面板：卡片行（标题/状态徽章/计数/相对时间）、恢复 JD、生成定制简历、状态推进菜单、删除两档（默认 SET NULL + purge AlertDialog 列数量清单）。
- `frontend/src/components/match/TaskModePicker.tsx` — 顺序改为 打招呼话术(默认) → 定制简历 → 一次搞定(进阶)。
- `frontend/src/app/app/dashboard/match/page.tsx` — 接入岗位列表面板开关；JD 失焦 detect 重复确认；生成后回填 `jobId` + 刷新面板；仅话术结果区「生成定制简历」CTA；默认 `taskMode` 改为 `pitch`。
- `frontend/src/components/match/CoverLetterPanel.tsx` — 支持 `jobId` 过滤。
- `frontend/src/i18n/locales/zh.json`、`en.json` — `jobmatch` 命名空间补齐岗位卡全部文案（状态徽章、删除两档、detect 确认、CTA、TaskMode 重排），两端同步。

**测试**
- `tests/test_jobs.py`（新增）— 5 个用例：自动建档/查重复用、detect 查重、accept 推进状态、越权 404、删除两档。全部通过。

### 迁移执行结果（生产库 jobmatch.db）
- 回填 35 张岗位卡；20 条话术 + 56 份匹配结果全部关联；状态分布 greeting_sent=4 / replied=18 / resume_ready=13；无孤儿、无重复 JD 分组。
- 执行前已备份（`jobmatch.db.bak.20260909104211`）。

### 验证结论
- 后端单测：`tests/test_jobs.py` 5/5 通过（含越权 404、删除两档语义）。
- 前端：`npx tsc --noEmit` 本批文件 0 报错；`npx vite build --outDir /tmp/...` 编译通过。
- 全量 `uv run pytest tests/` **83 passed**（2026-09-09 修复后）：原 `test_match_routes.py` / `test_resume_routes.py` / `test_ai_proxy_import.py` 的失败为**功能解耦（feature separation）阶段遗留的测试腐烂**（如 `_fake_run_match` 仍带 `with_cover_letter` 形参、`resume_import_from_pdf` 函数已移除、标题仍含 `.pdf` 扩展名），已核对现行产品契约后修复，未改动任何产品代码。

### 遗留问题
- V2 非目标（跟进提醒、title/company 自动提取、漏斗看板、JD 草稿暂存）按计划未实现。

---

## 十一、非目标与后续（V2 候选）

- 跟进提醒 / 漏斗统计（本周打招呼 n · 回复 m · 定制 k）——留存核心，单独立项；
- JD 资产化增强（可编辑标题、JD 历史版本）；
- 多简历 × 多 JD 矩阵视图；
- 岗位列表「归档」折叠视图（closed 卡按月分组，先于提醒功能）。

---

## 十二、V2：操作驱动状态机 + 独立岗位页（2026-09-09 追加）

> 用户在 V1 上线后的产品评审提出：状态不应靠手动点击维护，应随操作自动推导；
> 独立左侧菜单展示岗位与匹配结果。经方案评审（分析→四问确认）后实施。

### 状态模型（V1 5 态 → V2 4 态）

```
生成打招呼话术 ──(自动)──► greeting_sent 已打招呼·待回复
                                  │
直接匹配出定制简历 ─(自动)──► resume_ready 已定制·待投递 ──(手动确认投递成功)──► applied 已投递
                                  │                                    │
                                  └─────(手动 失败/放弃)──► closed 已结束(归档) ◄──┘
```

- 删除 `replied`：对方回复发生在平台外、无产出可推导，保留即被迫手动点（违背初衷）；
  回复动作由「去生成定制简历」隐含体现。
- 只前进不回退；`applied/closed` 不被内容操作覆盖；删子记录不自动回退；
- `closed` 为终态（归档），可手动「重新开启」——按卡下有无定制简历回到 `resume_ready`/`greeting_sent`；
  在 closed 卡上再次生成话术/简历视为「重新激活」，自动按产出回阶段。
- 初始态由**首动作**决定：只生成话术 → greeting_sent；直接匹配出简历（match-first 建卡）→ resume_ready
  （不再一律写死 greeting_sent，避免「从未打招呼却标待回复」）。

### 关键设计决策（用户四问确认，均采纳推荐项）

| 决策点 | 结论 |
|---|---|
| replied 去留 | 删除，4 态模型 |
| 「查看匹配结果」历史回看 | 匹配分析**落库**（此前仅当次返回、从不持久化） |
| 岗位页形态 | 独立左侧菜单「我的岗位」= 列表 + 同页详情区 |
| resume_ready 触发 | **生成定制简历即触发**（DerivedResume 落库即推进），不再等「接受」 |

### 改动落地

**后端**
- `app/models/derived_resume.py` — 新增 `analysis_json`（Text，存 MatchResult JSON）。
- `app/models/job.py` — `JOB_STATUSES` 收敛 4 态；新增 `JOB_STATUS_APPLIED/CLOSED/ACTIVE` 常量。
- `app/services/job.py` — 状态机集中：`promote_for_action`（只前进/终态锁/closed 复活）、`reopen_job`；
  `attach_or_create_job` 增 `initial_status`（首动作定初始态）。
- `app/api/cover_letter.py` — 生成话术接入 `promote_for_action`（greeting）。
- `app/api/match.py` — 生成定制简历即 `promote_for_action`(resume_ready) + 落库 `analysis_json`；
  accept 段旧手动推进收敛为幂等 promote；`get_derived` 返回持久化 `matchAnalysis`。
- `app/api/jobs.py` — PATCH 收窄为 title/company（`extra="forbid"`，传 status 422）；
  新增 `POST /{id}/mark {outcome: applied|closed}`（服务端合法迁移校验：applied 仅从 resume_ready）与
  `POST /{id}/reopen`；`GET /{id}` 详情内嵌子记录（话术 + 定制简历含分析）；列表支持 `include_closed`。
- `migrations/versions/h2c4d6e8a0f1_add_analysis_and_reproject_status.py`（新增）—
  加 `analysis_json` 列 + 存量状态重投影（replied 有简历→resume_ready / 无→greeting_sent）。

**前端**
- `frontend/src/lib/jobmatch.ts` — `JobStatus` 4 态；`JobDetail` 扩展 `cover_letters/derived_resumes`；
  `JobUpdate` 去 status；新增 `markJob`/`reopenJob`；`listJobs(includeClosed?)`。
- `frontend/src/app/app/dashboard/client.tsx` — 左侧导航新增「我的岗位」（Briefcase，路由 `/app/dashboard/jobs`）。
- `frontend/src/app/app/dashboard/jobs/page.tsx`（新增）+ `src/routes/app/dashboard/jobs.tsx`（新增）—
  独立岗位页：左列表（活跃 + 已归档分组）右同页详情（JD 可展开、阶段化 CTA、
  定制简历含匹配分析回看、话术记录、删除两档）；状态按钮收敛为两个手动确认 + 重新开启。
- `frontend/src/app/app/dashboard/match/page.tsx` — 移除抽屉 `JobListPanel`；工具栏「我的岗位」改跳转岗位页；
  新增 `?job=&mode=&run=` 意图处理（岗位页「生成/重新匹配」→ 工作台自动回填 JD 并发起匹配）。
- `frontend/src/components/match/JobListPanel.tsx`（删除）— 岗位管理职责移交独立页。
- i18n zh/en — 4 态徽章/按钮文案修订 + 岗位页新增文案。

**测试**：`tests/test_jobs.py` 扩至 8 用例（生成即推进+分析落库+详情回看、applied 前置校验、
closed 任意态归档、reopen 按产出回退、PATCH status 422、include_closed、越权、删除两档）。

### 验证
- 后端全量 `uv run pytest tests/`：**86 passed**。
- 前端：`npx tsc --noEmit` 本批文件 0 错误（剩余均为既有 legacy 报错）；`vite build` 通过，
  已生成 jobs 路由 chunk。
- 迁移冒烟：空库 upgrade→downgrade 链正常；开发库执行后 4 态分布
  greeting_sent=5 / resume_ready=31 / applied=1 / closed=0（replied 18 张按产出重投影），
  `analysis_json` 列就位；执行前已备份（`jobmatch.db.bak.20260909131440`）。
