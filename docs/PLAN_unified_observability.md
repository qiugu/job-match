# 统一可观测性重构方案（Unified Observability）

> 触发诉求（用户原话）：「重构可观测性页面，包括匹配可观测性、翻译可观测性，统一合并为可观测性；可观测性不止是成功率，还需要包含中间节点的执行状态等，结合社区最佳实践，重新设计可观测性」
>
> 日期：2026-11-05 ｜ 状态：**已实施**（评审结论见 §十，实现记录见 §十一）

---

## 一、现状盘点（已实测核实）

当前系统存在**三套割裂的观测体系**，且均以「成功率」为唯一核心维度：

| 能力 | 数据模型 | 聚合服务 | 前端 | 核心局限 |
| --- | --- | --- | --- | --- |
| 匹配可观测 | `match_runs` + `match_run_steps` | `services/match_stats.py` | `MatchingObservability.tsx`（analytics `matching` tab） | 节点状态已有，但模型封闭、无法覆盖其他端点 |
| 翻译可观测 | `llm_usage`（`detail` JSON 塞字段统计） | `services/ai_stats.py` | `TranslationObservability.tsx`（analytics `ai` tab） | 翻译是「单步」，靠 `detail` 列硬塞结果统计，无执行链 |
| 成本台账 | `llm_usage` | `services/usage.py::aggregate_usage` | admin 页 AI 段 | 只有 token/次数/耗时，无节点归因 |

**核心问题（根因）**：

1. **模型语义不统一**：匹配有独立的 run/step 两表；翻译、润色、语法、导入等端点只有一条 `llm_usage`，中间过程靠 `detail` JSON 临时塞数据，无法表达「节点执行链」。
2. **可观测性 = 成功率**：两个面板的 KPI 首卡都是成功率，节点维度的「执行状态、耗时分布、重试、错误归因」要么缺失、要么只在匹配内局部存在。
3. **前端两套语言**：`MatchingObservability` 与 `TranslationObservability` 虽复用 `Metric`/`Panel` 原语，但数据模型、聚合口径、明细下钻各自独立，新增一个端点就要复制一套。
4. **无成本与节点关联**：`llm_usage` 记录了成本，但无法回答「钱花在匹配的哪个节点上」「哪个节点最耗 token」。

---

## 二、目标与设计原则

### 2.1 目标

1. **单一「可观测性」页**：合并 `matching`/`ai` 两个 tab 为统一可观测性页，内部按「能力维度」（匹配 / 翻译 / 润色 / 语法 / 简历导入）切子视图，共享同一套 KPI、时间线、节点执行视图。
2. **可观测性不止成功率**：覆盖四维——成功率、节点执行状态与耗时分布、失败与错误归因、成本与用量。
3. **中间节点执行状态可读**：任何一次业务调用都能看到「跑了哪几步、每步成败、耗时、重试、错误类型」。

### 2.2 社区最佳实践对齐（OpenTelemetry Trace/Span 语义）

采纳 OpenTelemetry（OTel）的核心语义概念，但**不引入 OTel SDK 依赖**（当前单体规模用不上，且增加部署与采集成本），只借用其数据模型：

- **Trace（一次业务调用）**：一次匹配、一次翻译、一次润色… 都是一条 Trace，有唯一 `trace_id`、`started_at`、`completed_at`、总耗时、总状态。
- **Span（中间节点）**：Trace 内部的一个执行单元（如匹配的 `jd_extract` / `resume_match` / `keyword_optimize`；翻译的 `translate_fields`），有 `span_id`、父关系、`step_key`、`status`、`latency_ms`、`attempt`、`error_type`、token 用量。
- **状态语义**：`success` / `error` / `running` 三态，与现有 `match_run_steps` 一致；`attempt` 表达重试。
- **三大支柱映射**：
  - **Logs**：现有 `logger` 结构化日志（`match_stage` 已输出无正文 JSON），不变。
  - **Metrics**：Traces/Spans 聚合出的成功率、P50/P95 耗时、错误率、成本。
  - **Traces**：本次新增的统一 `traces`/`spans` 两表。

这与既有 `match_runs`/`match_run_steps` 的设计初衷一致——本次是把这套「匹配专属」模型**泛化到所有 AI 端点**，而非推翻重来。

---

## 三、数据模型（新建 traces / spans）

### 3.1 表结构

新建两张表（Alembic 迁移），语义对齐 OTel：

**`traces`（一次业务调用）**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | String(32) PK | trace_id（uuid4 hex） |
| `user_id` | String(32) 索引 | 归属用户，空串=无法归因 |
| `endpoint` | String(32) 索引 | 业务端点（复用 `llm_usage.ENDPOINT_*`：match / cover_letter / ai.polish / ai.grammar / ai.resume_import / ai.translate） |
| `status` | String(16) 索引 | `running` / `success` / `error` |
| `started_at` | DateTime 索引 | UTC |
| `completed_at` | DateTime 可空 | |
| `latency_ms` | Integer | 整段耗时 |
| `model` | String(64) | 生效模型（多模型取首） |
| `prompt_version` | String(16) | 生效 prompt 指纹 |
| `error_type` | String(64) | 顶层失败异常类名 |
| `error_message` | Text | 脱敏后的顶层错误信息 |
| `context_id` | String(32) 可空索引 | 业务上下文关联（匹配→`job_id`，翻译→`resume_id` 等，弱关联） |
| `detail` | Text | 端点级结构化摘要（JSON，**只存路径/计数/枚举，不存正文**），复用 `serialize_detail` 8KB 上限 |
| `created_at` | DateTime 索引 | |

**`spans`（中间节点）**

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | String(32) PK | span_id（uuid4 hex） |
| `trace_id` | String(32) 索引 | 所属 trace（逻辑外键，不建 FK 约束，对齐现有 `llm_usage.match_run_id` 惯例） |
| `parent_span_id` | String(32) 可空 | 父 span（预留嵌套；当前多为单层） |
| `step_key` | String(32) 索引 | 节点标识（`jd_extract` / `resume_match` / `keyword_optimize` / `translate` 等） |
| `status` | String(16) | `running` / `success` / `error` |
| `attempt` | Integer 默认 1 | 重试次数 |
| `started_at` | DateTime | |
| `completed_at` | DateTime 可空 | |
| `latency_ms` | Integer | |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | Integer | 该节点 token（对齐 `match_run_step` 既有列） |
| `model` | String(64) | 该节点生效模型 |
| `error_type` | String(64) | 节点级错误类名 |

### 3.2 与 `llm_usage` 的关系

- **`llm_usage` 保留为「成本台账」**：一条 = 一次业务端点调用，继续由 `track_llm` 写入，负责 token 累加、限流依据、成本聚合。**不再承载「过程观测」职责**。
- **`traces`/`spans` 为「执行链台账」**：负责节点级状态/耗时/重试/错误归因。
- 两者的 `id` 通过 `trace.id` 关联（`llm_usage` 现有 `match_run_id` 列在回填后可视为「指向 trace_id 的旧字段」，新写入由 `trace_id` 统一）。

---

## 四、写入改造

### 4.1 统一写入服务 `services/trace_observability.py`

新建统一写入/聚合服务（替代 `match_observability.py` 的职责，但保留后者兼容层）：

- `start_trace(user_id, endpoint, *, context_id=None) -> str`
- `record_span(trace_id, *, step_key, status, latency_ms, attempt=1, error_type="", prompt_tokens=0, completion_tokens=0, model="")`
- `finish_trace(trace_id, *, status, error=None, model="", prompt_version="", detail=None)`
- 全部走**独立短事务 + 吞异常**（观测旁路不影响业务，沿用 `match_observability.py` 既有纪律）。
- `TraceContext`（`ContextVar`）维护当前 trace_id，供 agent 节点内 `record_span` 自动归属（对齐 `match_run_context`）。

### 4.2 埋点改造点

| 调用点 | 现状 | 改造 |
| --- | --- | --- |
| `api/match.py` 匹配入口 | `start_match_run` / `finish_match_run` | 改为 `start_trace(ENDPOINT_MATCH)` / `finish_trace`；`match_run_context` → `trace_context` |
| `services/agent.py::_invoke_match_stage` | `record_match_step(run_id, ...)` | 改为 `record_span(trace_id, ...)`，`step_key=stage_name` 不变 |
| `api/ai.py` 翻译入口 | `track_llm` + `detail_ref` 塞翻译统计 | 在 `track_llm` 外包一层 `trace_context`，`finish_trace` 写单 span（`translate`）+ detail |
| `api/ai.py` 润色/语法/导入 | 仅 `track_llm` | 同样包 `trace_context` + 单 span（`polish` / `grammar` / `resume_import`） |
| 求职信端点 | 仅 `track_llm` | 同样包 trace + 单 span（`cover_letter`） |

> 原则：**每个「业务端点」入口统一走 `start_trace` / `finish_trace`；每个「内部节点」走 `record_span`**。`track_llm` 继续独立写 `llm_usage`（成本），两者解耦、互不依赖。

### 4.3 回填脚本（一次性，offline）

`scripts/backfill_traces.py`：把存量数据追插到新表，之后旧查询路径下线：

- `match_runs` → `traces`（`endpoint=match`，字段直映；`job_id` → `context_id`）
- `match_run_steps` → `spans`（`match_run_id` → `trace_id`，`step_key`/`status`/`attempt`/`latency_ms`/token/`error_type` 直映）
- `llm_usage` 中非 match 端点（`ai.translate` 等）→ 各生成一条 `trace`（`endpoint` 直映）+ 一条 `span`（`step_key` 取端点短名）

回填**幂等**（先查 `traces` 是否已有对应记录，避免重复）；完成后 `match_runs`/`match_run_steps` **保留不删**（避免破坏性迁移），但**停止写入**。

---

## 五、API 契约（统一可观测性）

新统一端点（保留旧端点作为过渡，标记 deprecated）：

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/observability?days=&endpoint=` | 登录用户（只看自己） | 统一 KPI（成功率/耗时分布/成本）+ 按端点/节点聚合 + 按日趋势 |
| GET | `/api/observability/traces/{trace_id}` | 登录用户（校验归属） | 单次 trace 详情：span 时间线（节点状态/耗时/重试/错误/ token） |
| GET | `/api/observability/nodes` | 登录用户 | 跨端点节点聚合：每个 `step_key` 的成功率、P50/P95、错误类型分布 |
| GET | `/api/admin/observability` | 管理员 | 跨用户全局视图（按端点分布、失败清单、成本归因） |

**响应契约（对齐 OTel）**：

```
{
  "range": {...},
  "overview": {           // 成功率仍是基础，但不再是唯一
    "total", "success", "error", "running",
    "success_rate", "avg_latency_ms", "p95_latency_ms",
    "total_tokens", "avg_tokens"
  },
  "nodes": [              // 中间节点执行状态（核心新增）
    { "step_key", "endpoint", "calls", "success", "error",
      "success_rate", "avg_latency_ms", "p50_latency_ms", "p95_latency_ms",
      "attempts_total", "error_types": {"TimeoutError": 3, ...} }
  ],
  "endpoints": [          // 按能力维度分布
    { "endpoint", "calls", "success_rate", "avg_latency_ms", "total_tokens" }
  ],
  "cost": {               // 成本与用量（核心新增）
    "total_tokens", "prompt_tokens", "completion_tokens",
    "by_endpoint": [...], "by_node": [...]
  },
  "daily": [...],         // 按日趋势（成功/失败/耗时/token 多序列）
  "recent_traces": [...]  // 最近调用列表（可展开节点时间线）
}
```

---

## 六、前端设计

### 6.1 页面结构（单一可观测性页）

analytics 页由三 tab（`delivery` / `matching` / `ai`）改为两 tab（`delivery` / `observability`）：

- **`delivery`**：投递表现（不变，默认页）。
- **`observability`**（「可观测性」）：统一页面，内部按能力维度切子视图（下拉/分段）：
  - 全部（All）· 匹配（Match）· 翻译（Translate）· 润色（Polish）· 语法（Grammar）· 导入（Import）
  - 每个子视图共享同一套 KPI、节点执行表、耗时分布、成本面板。

### 6.2 新组件 `ObservabilityView.tsx`

单一组件承载统一视图（替换 `MatchingObservability.tsx` 与 `TranslationObservability.tsx`），分区：

1. **KPI 卡**（6 卡）：调用次数 · 成功率 · 平均耗时（含 P95）· 节点总数 · 总 token · 错误次数。
2. **节点执行状态表**（核心新增）：每个 `step_key` 一行——状态徽标、成功率、P50/P95 耗时、平均重试次数、错误类型分布。这是「可观测性不止成功率」的直接落点。
3. **端点/能力维度分布**：按 endpoint 的成功率、耗时、token 条形。
4. **成本与用量面板**：token 总量 + 按端点/按节点归因。
5. **最近 trace 列表**：点击就地展开 span 时间线（节点顺序、每步状态/耗时/重试/错误）。

### 6.3 复用与命名

- 复用 `Metric`/`Panel` 原语（从现有组件抽出到 `analytics/observability-primitives.tsx`，避免交叉导入）。
- 新增纯函数 `observability-scale.ts`（node 可测）：节点耗时分布、错误类型聚合、成本归因、每日多序列。
- i18n 双写：`observability*` 命名空间统一，替换 `matchingKpi*` / `translationKpi*` 中与「可观测性」强耦合的文案；保留 `matching*` 语义 key 供过渡。

---

## 七、分阶段实施

| 阶段 | 交付物 | 验收 |
| --- | --- | --- |
| **P1 数据层** | `traces`/`spans` 模型 + Alembic 迁移 + `models/__init__.py` 注册 | `alembic current == heads`；迁移前备份 `jobmatch.db` |
| **P2 写入服务** | `services/trace_observability.py` + 各端点埋点改造（match/translate/polish/grammar/import/cover_letter） | 真实调用一次后 `traces`/`spans` 有记录；`llm_usage` 仍正常写成本 |
| **P3 回填** | `scripts/backfill_traces.py` 幂等回填 + 旧查询路径下线 | 回填后新旧数据一致；旧表停止写入 |
| **P4 统一 API** | `api/observability.py` 统一端点 + 聚合服务 `observability_stats.py` + Pydantic 响应 | 单测：归属校验、`days`/`endpoint` 白名单、空库零值、节点聚合口径 |
| **P5 前端** | `ObservabilityView.tsx` 统一页 + 能力维度切换 + analytics 页两 tab + `lib/jobmatch.ts` 类型/请求 + i18n | 真实数据下 KPI/节点表/成本/时间线均渲染；深色主题核对；空态可达 |
| **P6 收尾** | 删除/退役旧组件 + `docs/README.md` 索引 + `docs/ANALYTICS.md` 同步 + 文档实现记录 | 后端全量 + 前端全量通过；文档与实现一致 |

---

## 八、测试矩阵

| 层 | 用例 |
| --- | --- |
| 数据层 | traces/spans 建表；迁移图；trace_id 逻辑关联；`serialize_detail` 8KB 降级 |
| 写入层 | 匹配多节点→1 trace + 3 span；翻译→1 trace + 1 span；异常仍落 trace(status=error)+span；旁路失败不影响业务 |
| 回填层 | 幂等（重复执行不产生重复行）；match_runs→traces 字段映射；llm_usage 非 match→trace+span |
| 接口层 | 未登录 401；查他人 trace 404；非管理员 403；`days`/`endpoint` 白名单；空库零值；节点聚合 P50/P95 口径 |
| 前端 | 节点耗时分布/错误归因/成本归因纯函数；能力维度切换保持 `days`；时间线渲染；深色主题 |

---

## 九、风险与约束

| 风险 | 处理 |
| --- | --- |
| 迁移触达生产库 | 迁移前 `cp jobmatch.db jobmatch.db.bak.<ts>`；新增表非破坏性 |
| 回填数据一致性 | 幂等回填 + 回填后抽样比对；旧表保留可回查 |
| 双重写入期 | 新写入只走 traces/spans；`llm_usage` 仅成本，避免双轨漂移 |
| 隐私 | `detail` 只存路径/计数/枚举，不存正文；span 无正文；管理员 user_id 脱敏 |
| 深色主题 | 全走令牌，禁写死色值（沿用既有教训） |
| 依赖体积 | 不引入 OTel SDK，只借语义；无新增 Python/前端依赖 |

---

## 十、评审结论（2026-11-05）

| # | 事项 | 裁决 |
| --- | --- | --- |
| 1 | 页面形态 | **单一「可观测性」页**：analytics 由三 tab 并为 `delivery` + `observability`，内部按能力维度切子视图 |
| 2 | 追踪模型 | **新建 `traces`/`spans` 两表**（对齐 OTel 语义），`llm_usage` 保留为纯成本台账 |
| 3 | 观测维度 | 成功率（基础）+ 节点执行状态（P50/P95/重试/错误归因）+ 成本用量（token 归因） |
| 4 | 存量数据 | **一次性幂等回填**后下线旧查询路径 |
| 5 | 旧表处置 | `match_runs`/`match_run_steps` **保留不删、停止写入** |
| 6 | 新增观测维度 | **JD 图片提取可观测**：图片上传到 JD 输入框时，识别过程作为独立 trace（endpoint=`jd.image_ocr`，step=`jd_image_extract`），记录图片数/识别字符数/耗时/有无文字，**仅记录不判定**——「提取是否正确」由人工对照识别结果回查 |

---

## 十一、实现记录

### 11.1 数据层（P1）

- 迁移 `q9j2k4l6n8p0_add_unified_observability.py`（`down_revision = p8i0k2l4n6q8`）：新增 `traces`（一次业务调用）与 `spans`（中间节点）两表。
- 模型 `app/models/trace.py` / `app/models/span.py`；`models/__init__.py` 与 `database.py` 已注册。
- **已实际执行**：迁移前备份 `jobmatch.db.bak.20261105112733`；`alembic current == heads == q9j2k4l6n8p0`；两表可用 `sqlite_master` 查到。

### 11.2 写入服务与埋点（P2）

- 新增 `services/trace_observability.py`：`start_trace` / `record_span` / `finish_trace` + `trace_context`（ContextVar），全部独立短事务 + 吞异常（旁路不影响业务）。
- 埋点改造：
  - `api/match.py`：匹配入口 `start_trace(ENDPOINT_MATCH)` / `finish_trace`；JD 图片识别独立 trace（`ENDPOINT_JD_IMAGE_OCR` + `jd_image_extract` span）。
  - `services/agent.py::_invoke_match_stage`：`record_match_step` → `record_span`，并从 usage 回调补齐节点 token。
  - `api/ai.py`：translate / grammar / resume_import / polish（流式）各包 trace + 单 span。
  - `api/cover_letter.py`：话术生成包 trace + 单 span。
- `llm_usage.ENDPOINT_JD_IMAGE_OCR = "jd.image_ocr"` 新增常量。

### 11.3 回填（P3）

- `scripts/backfill_traces.py`：`match_runs`→`traces`、`match_run_steps`→`spans`、`llm_usage`(非 match)→trace+span，幂等（重复执行不重复落库）。
- 实测：2 runs + 4 steps + 24 llm_usage → 26 traces + 28 spans；二次执行增量 0。

### 11.4 统一 API 与聚合（P4）

- `services/observability_stats.py`：`compute_observability`（overview/nodes/endpoints/cost/daily/recent_traces）+ `get_trace_detail`（span 时间线）。
- `api/observability.py`：`GET /api/observability`（用户侧）、`GET /api/observability/traces/{id}`、`GET /api/observability/admin`（管理员）。旧端点保留（deprecated）。

### 11.5 前端（P5）

- `ObservabilityView.tsx`：能力维度切换 + 6 KPI 卡 + 节点执行状态表（P50/P95/重试/错误归因）+ 端点分布 + 成本面板 + 最近调用（可展开 span 时间线）。
- `observability-primitives.tsx`（Metric/Panel 原语）、`observability-scale.ts`（纯函数，node 可测）。
- analytics 页改两 tab（`delivery` + `observability`）；旧 URL `?tab=matching`/`?tab=ai` 兼容落到 observability。
- `lib/jobmatch.ts` 新增 `Observability`/`TraceDetail` 类型与 `getObservability`/`getTraceDetail`/`getAdminObservability`。
- i18n zh/en 双写（`observability*` 系列 + `observabilityNode.*` + `observabilityEndpoint.*`）。
- **退役** `MatchingObservability.tsx` 与 `TranslationObservability.tsx`（删除）；`matching-scale.ts`/`translation-scale.ts` 纯函数层保留（被 AdminAiSection 与既有测试引用）。

### 11.6 与规划的三处差异

1. **`record_span` 无 `detail` 列**：span 只承载节点级状态/耗时/token/错误；端点级摘要（翻译字段统计、JD 图片识别图片数）统一存 `finish_trace` 的 `detail`（trace 级）。避免「同一份摘要同时存两处」的口径漂移。
2. **JD 图片识别独立端点**：新增 `ENDPOINT_JD_IMAGE_OCR = "jd.image_ocr"`（而非复用 `ai.resume_import`），避免「JD OCR」被误归为「简历导入」。
3. **管理员跨用户聚合的内存策略**：节点/端点聚合当前在进程内完成（而非 SQL group by），因为现有数据规模（单体 SQLite）下收益可忽略；规模增长后再下沉 SQL（已记入 §九 风险）。

### 11.7 验证证据

- 后端全量 **303 passed**（原 296 + 新增 `tests/test_unified_observability.py` 7 例）。
- 前端相关 **20 passed**（新增 `tests/observability-scale.test.ts` 7 例；更新 `navigation-and-match-regression.test.ts` 与 `matching-observability.test.ts` 适配新表）。
- `tsc --noEmit`：新增文件零报错（既有 `next` 模块缺失与 tests 类型宽松问题与本改动无关）。

---

## 十二、已知限制

- 管理员跨用户视图下 `traces`/`spans` 聚合在进程内完成；数据量大时需下沉 SQL group by（当前单体规模不触发）。
- 旧端点 `/api/derived-resumes/observability` 与 `/api/ai/translate/observability` 读旧表，新数据不回填到旧表，故旧端点只反映回填时点之前的存量数据；新数据一律走 `/api/observability`。
