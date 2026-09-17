# 规划：投递统计分析（Delivery Analytics）

> 状态：**已实现（2026-09-16）**。本文档保留原评审口径，与实现的偏差已在对应小节以「实现备注」标注；权威口径见 `docs/ANALYTICS.md`。
> 目标：为「我的投递（岗位卡）」增加统计分析页与图表，回答「每天投递情况如何」。

---

## 1. 问题陈述与根因

用户诉求：*增加投递统计分析及分析图表，分析每天的投递情况。*

**根因（阻塞项）**：`jobs` 表（`app/models/job.py`）仅有 `created_at` / `updated_at`：

| 字段 | 语义 | 能否支撑「某天投递了几家」 |
| --- | --- | --- |
| `created_at` | 建卡时间 | ✗ 建卡 ≠ 投递 |
| `updated_at` | 任意写入都会更新（`onupdate=_now`） | ✗ 改标题/公司、任何状态推进都会刷新它 |

即：**投递发生的时间点没有留下任何不可变记录**。

若直接用 `updated_at` 近似投递日：
1. 用户 PATCH 一次 `company` 字段，历史图表即发生漂移；
2. 无法区分「建卡」「生成话术」「生成简历」「投递」四件事；
3. 无法计算漏斗转化率与投递周期。

**结论**：必须以 append-only 的**状态事件台账**承载时间事实。这与项目既有惯例一致（`llm_usage` 台账表即同类设计，`docs` 注释明确「一条记录 = 一次业务动作」）。

---

## 2. 方案总览

```
[写入侧]  状态变更 → transition() 唯一收口 → 同时写 jobs.status + job_status_events
[读取侧]  GET /api/jobs/stats?days=30&tz_offset=480 → 按用户本地日历日分桶
[展示侧]  /app/dashboard/analytics → ECharts（按需引入 + 主题令牌桥接）
```

### 2.1 数据模型

新增表 `job_status_events`（append-only，只插不改）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | String(32) PK | uuid4 hex，与全库一致 |
| `user_id` | String(32) NOT NULL | 归属用户，越权隔离依据 |
| `job_id` | String(32) NOT NULL | 归属岗位卡 |
| `from_status` | String(32) NULL | 变更前状态；建卡为 NULL |
| `to_status` | String(32) NOT NULL | 变更后状态 |
| `source` | String(16) NOT NULL | `create` / `auto` / `manual` / `reopen` / `backfill` |
| `occurred_at` | DateTime NOT NULL | **事实时间**（不可变，UTC naive） |

索引：`(user_id, occurred_at)` 复合（时间窗查询主路径）、`(job_id)`（删除级联）。

**不建 FK 约束**：与 `llm_usage` 一致，避免 SQLite 下 FK 顺序耦合；一致性由服务层保证。

### 2.2 状态写入收口（防止漏记事件）

现状：状态写入散落在 4 处（`attach_or_create_job` 建卡、`promote_for_action`、`reopen_job`、`api/jobs.py::mark_job`）。若逐处补写事件，必然漏。

改法：在 `app/services/job.py` 新增**唯一**状态写入口

```python
async def transition(db, user_id, job, new_status, source) -> bool:
    """唯一的 job.status 写入点：同时落状态与事件（from==to 视为无变更，不写）。"""
```

- `promote_for_action` / `reopen_job` 内部改为调用 `transition`；
- `api/jobs.py::mark_job` 也改为调用 `transition`（`source="manual"`）；
- 建卡时 `source="create"`，`from_status=None`。

### 2.3 迁移 `j3f5a7b9c1d2`（add job_status_events）

`down_revision` = 当前 head（执行前以 `alembic heads` 实测确认，不凭推断）。

**存量回填**（关键取舍）：

| 存量卡当前状态 | 回填事件 |
| --- | --- |
| 任意 | `NULL → greeting_sent` @ `created_at`，`source=backfill`（代表"建卡"） |
| ≠ greeting_sent | `greeting_sent → <status>` @ `updated_at`，`source=backfill` |

> **⚠ 已知不精确**：存量 `applied` 卡的真实投递日**不可考**，只能用 `updated_at` 近似。
> 处理方式：不隐藏、不粉饰——回填事件在 API 中标记 `source=backfill`，图表用斜纹底纹 + 图例说明区分。新产生的数据为精确值。

### 2.4 统计端点

`GET /api/jobs/stats?days=30&tz_offset=480`

> **⚠ 路由顺序陷阱**：必须声明在 `GET /{job_id}` **之前**，否则 `/api/jobs/stats` 会被 `{job_id}` 吞掉、按"岗位不存在"返回 404。已作为回归测试用例。

参数：
- `days`：白名单 `7|14|30|90|180|365`（非白名单 → clamp 到最近的合法值，上限 365）；
- `tz_offset`：分钟，`-720 ~ 840`，默认 `480`（UTC+8）。前端传 `-new Date().getTimezoneOffset()`。

响应（`app/schemas/job.py::JobStats`）：

```jsonc
{
  "range":   { "days": 30, "start": "2026-08-17", "end": "2026-09-16", "tz_offset": 480 },
  "totals":  {
    "jobs": 12, "active": 5, "applied_now": 6, "closed_now": 1,
    "applied_ever": 6, "closed_ever": 1,           // 历史曾到达口径（漏斗/投递率用）
    "applied_in_range": 4, "created_in_range": 5, "closed_in_range": 1,
    "applied_rate": 0.5,            // applied_ever / jobs
    "avg_days_to_apply": 3.2,       // 首次投递 − 建卡，均值（天，1 位小数）；无投递为 null
    "avg_derived_per_applied": 2.3, // 定制简历总数 / 曾投递卡数；无投递为 null
    "cover_letters": 20, "cover_letter_jobs": 8, "derived_resumes": 14,
    "backfilled_jobs": 3            // 日期为回填近似值的卡数（前端据此展示回填说明）
  },
  "status_distribution": { "greeting_sent": 2, "resume_ready": 3, "applied": 6, "closed": 1 },
  "funnel":  [ {"key":"created","count":12,"rate":1.0},       // 3 级累计到达，单调不增
               {"key":"resume_ready","count":9,"rate":0.75},
               {"key":"applied","count":6,"rate":0.5} ],
  "daily":   [ {"date":"2026-08-17","created":1,"greeting":1,"resume_ready":0,
                "applied":1,"closed":0,"backfill":false}, /* … 缺日补零，连续 */ ],
  "weekday": [0,0,0,0,0,0,0],    // 周一…周日 投递事件数
  "streak":  { "current": 3, "best": 5 }
}
```

**口径定义（写进交付文档，避免歧义）**

| 指标 | 公式 | 备注 |
| --- | --- | --- |
| `appliedRate` | `applied / jobs` | 存量口径：全部机会中最终投出去的比例 |
| `avgDaysToApply` | `mean(applied 事件时间 − 建卡事件时间)` | 跨周中按用户本地日差 |
| `avgDerivedPerApplied` | `derived 总数 / 曾投递卡数` | 回答"投一个岗平均改几版简历" |
| `funnel` | 每级 = 曾达到**该级或更后一级**的卡数（取每卡最高阶段），3 级：created → resume_ready → applied | `closed` 是终态分支不计入；漏斗必单调不增 |
| `daily[].*` | 当日 `to_status` 命中数 | 按 `(occurred_at + tz_offset)` 的日历日分桶 |
| `streak` | 以本地日历日计，连续有 `applied` 事件的天数 | |

**分桶实现**：查时间窗内事件后在 Python 内分桶，而非 SQL `strftime`。
理由：SQLite 方言专有 + 时区偏移拼接易错；单用户事件量为百级，Python 分桶可读且便携。

**删除卡时的口径**：删除岗位卡（两种模式）同步删除其事件。口径 = 「当前仍存在的岗位卡的行为」，与列表页一致，避免"列表 3 张卡、统计说 10 次投递"的认知冲突。**此点需你确认。**

### 2.5 前端

**新增路由** `/app/dashboard/analytics`
- `src/routes/app/dashboard/analytics.tsx`（薄壳，与其他子路由一致）
- `src/app/app/dashboard/analytics/page.tsx`（页面）
- 侧栏 `dashboard/client.tsx` 新增 entry「投递分析」（置于「我的投递」之后）
- 图标：实现时直接复用 lucide 的 `BarChart3`（与同组 `Briefcase` 来源一致），未再新增 `XaiIcons.IconChart`

**图表实现：ECharts（按需引入 + 主题令牌桥接）**

> 决策 D2 采你所选：使用 ECharts（而非手写 SVG）。
> 依赖前置：实测 `frontend/node_modules` 无 `echarts` / `zrender`，需新增依赖。
> 安装前置动作（本机风险已知）：先记录 `package.json` / `pnpm-lock.yaml` 的 sha256，
> 安装后立即核对；若被 safe-delete 守卫中断则用 git 回退并改用 CDN 动态加载方案。

**按需引入（tree-shaking）**——不使用 `import * as echarts from "echarts"`（全量约 1MB）：

```ts
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, CanvasRenderer]);
```

**双主题桥接（关键技术点）**

ECharts 在 Canvas 上渲染，**无法解析 CSS 变量**。而本项目的主题是 `html.light` / `html.dark`
上的 class（`next-themes` 驱动），且颜色定义在 `.theme-xai` 作用域内。因此：

- 新增 `tokens.ts`：以 `getComputedStyle(el).getPropertyValue("--xai-*")` 在**运行时**解析真实色值，
  构造 ECharts 的 `textStyle` / `axisLine` / `splitLine` / 序列配色；**禁止**硬编码十六进制色值；
- 新增 `useThemeTick()`：`MutationObserver` 监听 `<html>` 的 `class` 变化 → 自增计数器 →
  触发 `setOption` 重绘。仅监听 class 属性，不做轮询。
- 图表容器必须置于 `.theme-xai` 子树内，否则取不到令牌（此前提已在 `MEMORY.md` 中记录为项目已知坑）。

**组件（`src/components/analytics/`）**

| 组件 | 内容 | 可测性 |
| --- | --- | --- |
| `EChart.tsx` | 通用封装：init / setOption / `ResizeObserver` 自适应 / dispose / 主题变化重绘 | 集成 |
| `tokens.ts` | 令牌解析 → 图表配色映射 | 纯函数可测 |
| `options.ts` | 各图表的 ECharts option 构造 | **纯函数可测** |
| `scale.ts` | 分桶 / 值域缩放 / 日期轴刻度 / 补零 | **纯函数可测** |
> **实现备注**：未按上表拆独立图表组件——各图表 option 已是纯函数（`options.ts`），页面内仅保留 `KpiCard` / `ChartPanel` 两个展示壳，避免一层无逻辑的转发组件。回填日最终以 `markArea` 色带表达（比 `itemStyle` 斜纹更不易被误读为数值）。

**动效与可访问性**：图表使用 ECharts 原生 `animationDuration` / `animationDelay`（stagger）；
`prefers-reduced-motion: reduce` 时关闭动画（`animation: false`）；
每个图表容器带 `role="img"` + `aria-label`，并在旁边提供**文字摘要**（不依赖颜色单独传达信息）。

**设计方向：editorial data console（编辑式报表）**

延续产品既有的克制语言，而非套用通用 BI 面板：
- 唯一强调色为品牌靛蓝 `#5E6AD2`（占比 ≤10%），其余靠中性层级 + 1px 描边表达；
- 数字统一 `font-mono tabular-nums`，KPI 用 32–40px 细字重形成"报表"质感；
- 加载时柱状条以 30ms stagger 自基线展开（CSS transform，单次）；`prefers-reduced-motion` 下禁用；
- 严格跟随 `theme-xai` 双主题（浅色/深色均需可读，颜色全部走具名令牌，不硬编码）。

**空态**：零岗位卡时显示引导（跳转匹配页），不渲染空图表。

**i18n**：`jobmatch` 命名空间新增约 45 个 `analytics*` 键，`zh.json` / `en.json` 同步。

### 2.6 测试

**后端 `tests/test_job_stats.py`**（复用 `conftest.py` 的临时库 + monkeypatch 惯例）：
1. 事件写入完整性：建卡 / 话术推进 / 简历推进 / mark applied / mark closed / reopen，各自 `from`/`to`/`source` 正确；
2. **`from == to` 不产生事件**（幂等 mark 不污染统计）；
3. `daily` 时区分桶正确，含 **UTC 23:30 事件在 UTC+8 应落入次日** 的跨日边界用例；
4. `days` 白名单与 clamp、`tz_offset` 边界；
5. `funnel` 按"每卡最早到达"计数（而非当前状态）；
6. `appliedRate` / `avgDaysToApply` / `avgDerivedPerApplied` 数值正确；
7. **越权隔离**：他人事件不计入；
8. 删除卡后事件同步清除、统计随之变化；
9. **路由顺序**：`GET /api/jobs/stats` 返回 200 而非 404（防 `{job_id}` 吞路由回归）。

**前端 `frontend/tests/analytics-scale.test.ts`**：`scale.ts` 纯函数单测（分桶补零、值域缩放、跨月日期轴、空数据不除零）。
> 说明：本项目 vitest 为 node 环境（无 jsdom），组件渲染不在单测覆盖范围，靠 `scripts/editor-probe/` 的真实 Chromium 截图与人工核对。

**迁移验证（交付物 = 已生效的库）**：执行 `alembic upgrade head`，并以实测证据确认三点：
1. `alembic current` == `alembic heads`；
2. `job_status_events` 表与其索引真实存在（直连库查）；
3. 回填行数与 `jobs` 表现存卡数吻合。
> 前置：**先备份 `jobmatch.db`**（应用启动会自动 upgrade head）。

### 2.7 交付物

| 类型 | 路径 |
| --- | --- |
| 代码（后端） | `app/models/job_event.py`、`app/services/job.py`、`app/api/jobs.py`、`app/schemas/job.py`、`app/models/__init__.py`、迁移文件 |
| 代码（前端） | `lib/jobmatch.ts`、`components/analytics/*`、`app/app/dashboard/analytics/page.tsx`、`routes/app/dashboard/analytics.tsx`、`dashboard/client.tsx`、`XaiIcons.tsx`、`i18n/locales/{zh,en}.json` |
| 测试 | `tests/test_job_stats.py`、`frontend/tests/analytics-scale.test.ts` |
| 文档 | `docs/ANALYTICS.md`（指标口径 / 事件模型 / 时区处理 / 回填不精确性 / 已知限制） |

---

## 3. 执行顺序

1. 备份 `jobmatch.db` → 建模型 + 写迁移 → 执行 `alembic upgrade head` → 直连库验证；
2. 后端状态收口 `transition()` + 事件写入 → 统计端点 → schema；
3. 后端测试 `test_job_stats.py` 全绿；
4. 前端 API 客户端 + `scale.ts` + 图表组件 + 页面 + 路由 + 侧栏 + i18n；
5. 前端 `scale.ts` 单测全绿；
6. 代码审查（可读性/注释、性能与安全、项目风格）；
7. 文档 `docs/ANALYTICS.md` + 更新 `AGENTS.md` 的 API 索引。

## 4. 待你确认的决策点

| # | 决策点 | 建议 | 备选 |
| --- | --- | --- | --- |
| D1 | 是否为统计引入状态事件台账（含新表 + 迁移） | **引入**（唯一能回答"每天投递"的正确做法） | 仅用 `updated_at` 近似（零迁移，但数据会漂移、口径不可信） |
| D2 | 图表实现 | ✅ **已采 ECharts 6.1.0（用户选定）**，按需引入约省 70% 体积 | ~~手写 SVG~~（评审时被否） |
| D3 | 入口位置 | **侧栏独立页 `/analytics`** | 嵌入「我的投递」页顶部（页面已有 754 行，会更臃肿） |
| D4 | 删卡时事件处理 | **同步删除**（口径与列表一致） | 保留事件（"历史投递总数"含已删卡，与列表数字不一致） |
| D5 | 存量 `applied` 回填 | **用 `updated_at` 近似 + UI 明确标注为回填** | 不回填（首屏图表空白，体验差） |
