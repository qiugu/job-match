# 投递统计分析（Delivery Analytics）口径说明

> 权威口径文档。前端页面：`/app/dashboard/analytics`；规划与决策记录见
> `docs/PLAN_delivery_analytics.md`。本文回答一个问题：**页面上每个数字是怎么算出来的**。

---

## 1. 数据基础：状态事件台账

### 1.1 为什么不是 `jobs.updated_at`

`jobs` 表只有 `created_at` / `updated_at`，而 `updated_at` 被任何写入刷新
（改标题/公司、任何状态推进）。用它当「投递日」意味着用户改一次公司名，
历史图表就整体漂移。**「某天投递了几家」这一事实必须有一条不可变记录。**

### 1.2 表结构 `job_status_events`（迁移 `j3f5a7b9c1d2`）

| 列 | 说明 |
| --- | --- |
| `id` | uuid4 hex PK |
| `user_id` | 归属用户（越权隔离依据） |
| `job_id` | 归属岗位卡 |
| `from_status` | 变更前状态；**建卡事件为 NULL** |
| `to_status` | 变更后状态 |
| `source` | `create` / `auto`（操作驱动推进）/ `manual`（手动确认）/ `reopen` / `backfill`（迁移回填） |
| `occurred_at` | **事实时间**，UTC naive，不可变 |

- append-only：只插不改。状态流转历史即业务事实史。
- 索引：`(user_id, occurred_at)`（时间窗主路径）、`(job_id)`（删除级联）。
- 不建 FK：与 `llm_usage` 台账同惯例，避免 SQLite 下 FK 顺序耦合；一致性由服务层保证。

### 1.3 唯一状态写入口

所有状态变更必须经 `app/services/job.py::transition()`——它同时写
`jobs.status` 与事件行；`from == to` 视为无变更（幂等确认不产生重复事件）。
调用方：建卡（`source=create`）、`promote_for_action`（`auto`）、
`reopen_job`（`reopen`）、`api/jobs.py::mark_job`（`manual`）。
**代码中不允许出现 `job.status = ...` 直写**（`api/jobs.py` 已清零，并有测试守护）。

### 1.4 存量回填与近似性（重要）

迁移把存量卡按 `created_at` / `updated_at` 回填为事件链（`source=backfill`）：

| 存量状态 | 回填事件 |
| --- | --- |
| 任意 | `NULL → greeting_sent` @ `created_at`（代表建卡） |
| ≠ greeting_sent | `greeting_sent → <当前状态>` @ `updated_at` |

**回填日期是近似值**：`updated_at` 可能被后续编辑覆盖过。处理原则——
不隐藏、不粉饰：含回填事件的日期在 `daily[].backfill` 标为 `true`，
图表以浅色底纹（`markArea`）区分，并在图下方给出说明文案。
**迁移之后新产生的事件是精确值**，随时间推移回填区间自然移出统计窗口。

---

## 2. 端点

```
GET /api/jobs/stats?days=30&tz_offset=480
```

- `days`：白名单 `(7, 14, 30, 90, 180)`，非白名单 clamp 到最近合法值。
  上限 180 = 归档岗位保留期（`JOB_RETENTION_DAYS`，见 §7.6）：更早的事件已随
  过期归档卡清理，长区间会缺数，故刻意不提供更长区间。
- `tz_offset`：分钟、东为正，范围 `[-720, 840]`，默认 `480`（UTC+8）。
  前端必须显式传 `-new Date().getTimezoneOffset()`——库内存 UTC，
  后端不假定用户时区。
- ⚠ 路由顺序：`/stats` 声明在 `/{job_id}` **之前**（否则被吞成 404），有回归测试。

---

## 3. 指标口径公式

| 指标 | 公式 | 说明 |
| --- | --- | --- |
| `totals.jobs` | 当前存在的岗位卡总数 | 一切口径的基数 |
| `totals.applied_now` | 所选区间新建岗位 cohort 中当前状态 = applied 的卡数 | 随 `days` 变化；存量视角 |
| `totals.applied_ever` | 全部现存岗位曾发生过 `→ applied` 事件的卡数 | 含后来归档的，总览 KPI 口径 |
| `totals.applied_rate` | `applied_ever / jobs` | 0~1 |
| `totals.avg_days_to_apply` | `mean(首次 applied 事件 − 建卡事件)` | 按本地日历日差；无投递为 `null` |
| `totals.avg_derived_per_applied` | `derived_resumes / applied_ever` | 「投一个岗平均改几版简历」 |
| `totals.backfilled_jobs` | 有 `source=backfill` 事件的卡数 | 前端据此展示回填说明 |
| `funnel[n]` | 所选区间新建岗位 cohort 中，曾达到**该级或更后一级**的卡数 | 3 级：created → resume_ready → applied；单调不增；`closed` 是终态分支不计入 |
| `daily[d].*` | 当日 `to_status` 命中数 | 分桶见 §4；缺日补零、日期升序 |
| `daily[d].backfill` | 当日含 backfill 事件 | 日期为近似值 |
| `weekday[i]` | 周一…周日的 applied 事件数 | 恒为长度 7 |
| `streak.current` | 区间窗口内以最后一天倒数，连续有 applied 事件的天数 | 今天/昨天无投递则为 0（今天没投允许以昨天为终点延续） |
| `streak.best` | **区间窗口内**最长连续投递天数 | 扩大 `days` 可回看更长历史 |

**范围口径**：恒为「当前存在的岗位卡」。删卡（两种模式）同步删除其事件，
未归类（`job_id` 为空）的话术/简历不计入——**统计页数字与「我的投递」列表页永远一致**。
其中漏斗与存量状态分布按所选区间内新建岗位 cohort 统计，日趋势与星期分布按区间内事件统计。

---

## 4. 时区处理

- 库内 `occurred_at` 为 **UTC naive**。
- 分桶公式：`local_date = (occurred_at + tz_offset 分钟).date()`，在 Python 内完成
  （不用 SQL `strftime`：方言专有、偏移拼接易错；单用户事件量为百级）。
- 例：UTC `23:30` 的投递在 `tz_offset=480` 时落入**次日**（有跨日边界测试）。
- 区间 `start`/`end` 为用户本地日历日的闭区间，响应中原样返回供前端核对。

---

## 5. 前端结构与实现约定

```
frontend/src/components/analytics/
├── tokens.ts    # 令牌桥接：getComputedStyle 解析 --xai-*（Canvas 读不到 CSS 变量）
├── scale.ts     # 纯函数：缩放/抽稀/整形/格式化（vitest node 环境可测）
├── options.ts   # 纯函数：各图表 ECharts option 构造（仅 import type echarts）
└── EChart.tsx   # 封装：init/ResizeObserver/dispose + <html> class 监听重绘
                 # + prefers-reduced-motion 降级
```

- **双主题**：主题是 `html.light/dark` class（next-themes），色值定义在
  `.theme-xai` 作用域 ⇒ ECharts 必须运行时解析令牌；页面容器必须位于
  `.theme-xai` 子树内。图表代码**禁止硬编码色值**（唯一例外 `BRAND_ACCENT = #5E6AD2`）。
- **单色阶语义**：阶段是有序量 ⇒ 靛蓝单色阶（applied 满色 → 越早越浅），
  `closed` 用中性灰不参与色阶。
- **计数轴**：`minInterval: 1`，杜绝「0.5 个投递」刻度。
- **依赖**：`echarts@6.1.0` 按需引入（BarChart/PieChart + Grid/Tooltip/Legend/MarkArea + Canvas），
  禁止 `import * as echarts from "echarts"` 全量引入（约 1MB）。
- 侧栏入口：`dashboard/client.tsx`（lucide `BarChart3`，与同组 `Briefcase` 一致）。

## 6. 测试

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 后端 | `tests/test_job_stats.py`（21 例） | 事件完整性、幂等不记事件、UTC 23:30 跨日、白名单 clamp、漏斗累计口径、KPI 数值、越权隔离、删卡级联清事件、`/stats` 路由顺序 |
| 后端全量 | `pytest tests/` | 145 例全绿（收口重构无回归） |
| 前端 | `tests/analytics-scale.test.ts`（24 例） | 缩放/抽稀/整形/格式化、tokens 混色、四类 option 结构契约、`JobStats` 形状守护 |

## 7. 已知限制

1. **回填近似**：迁移前的历史投递日期不可考（§1.4），UI 已标注；新数据精确。
2. **手动建卡≠投递**：用户可直接把卡标为 applied（`source=manual`），口径忠实记录操作时间。
3. **多设备时区**：分桶按请求时的 `tz_offset`；用户跨时区使用时，同一天的归属以查询时的时区为准。
4. **删卡即失忆**：已删卡不计入统计（产品决策 D4，为与列表页一致）。若未来要「历史总投递量」口径，需改为软删或事件保留策略。
5. **编辑器语义**：本页只读，不提供手动改状态；状态仍由操作驱动（与岗位卡页一致）。
6. **保留策略（2026-10-29）**：已归档（closed）岗位卡保留 `JOB_RETENTION_DAYS`
   天（默认 180），由 `app/services/job_cleanup.py` 在启动时与每 24 小时各清理一次：
   子资产（话术/匹配结果）`job_id` 置空转「未归类」保留，状态事件随卡删除，活跃卡
   永不清理。因此统计区间上限与保留期对齐（均为 180 天），两页指标分工——
   「我的投递」页只展示执行层指标（待回复/待投递/本周已投递/连续天数），
   转化率、漏斗、趋势、分布等复盘指标只在本页展示，两页不重复。

---

## 8. 匹配可观测性（Match Observability）

投递分析页的第二个 Tab 为「匹配可观测性」，数据来源是 `match_runs`、
`match_run_steps` 与带 `match_run_id` 的 `llm_usage` 台账。它观察的是用户的
匹配运行质量，不改变本页原有投递统计。

### 8.1 运行口径

- 一次点击匹配创建一条 `match_runs`，状态为 `running`、`success` 或 `error`。
- 成功的定义是匹配结果已生成并成功保存为定制简历；LLM 失败、超时、解析失败或
  最终持久化失败都记为 `error`。
- 每个 Agent 节点的每次尝试写入一条 `match_run_steps`；可恢复错误重试时保留
  每次尝试，便于区分节点失败与重试成功。
- 运行耗时从首次开始到成功/失败收口；失败运行产生的 Token 与耗时仍保留。
- 匹配开始时岗位卡可能尚未创建，因此 `job_id` 允许为空，成功落库后补齐。

### 8.2 接口

```text
GET /api/derived-resumes/observability?days=30&tz_offset=480
GET /api/derived-resumes/observability/runs/{run_id}
```

`days` 沿用本页白名单 `(7, 14, 30, 90, 180)`，`tz_offset` 为分钟且东为正。
接口只返回统计字段、岗位摘要和节点状态，不返回原始 JD 或完整简历文本，并按
当前用户隔离。

### 8.3 指标解释

- 成功率 = 成功运行数 / 区间内运行总数。
- 平均耗时、P95 耗时只统计已经结束的运行；无样本时前端显示 `—`。
- 平均匹配得分来自模型返回的 `MatchResult.score`，只是模型评估结果，不能解释为
  录用概率。
- 匹配后投递率 = 成功匹配且关联岗位当前状态为 `applied` 的运行数 / 成功运行数，
  只表示当前历史数据的相关性，不代表因果关系。
- `matched`、`weak`、`missing`、`unsupported` 来自匹配结果中的要求项，旧字段拼写
  `unspported` 在观测层统一归入 `unsupported`。
