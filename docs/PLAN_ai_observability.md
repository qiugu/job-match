# AI 可观测性：把翻译的调用过程接入既有观测页

> 触发诉求（用户原话）：「AI 翻译的可观测性都要体现到可观测页面上去，展示 AI 匹配的过程，而不是靠猜」
>
> 日期：2026-10-29 ｜ 状态：**已评审**（四项裁决见 §十），实施中

---

## 一、现状盘点（已实测核实）

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 匹配过程观测 | **已完整**：`match_runs` + `match_run_steps` 由 `api/match.py`（start/finish）与 `services/agent.py`（record_match_step）写入；`services/match_stats.py` 提供聚合；`GET /api/derived-resumes/observability` + `/runs/{id}` 已上线；前端 `components/analytics/MatchingObservability.tsx` 挂在 analytics 页 `matching` tab | 无（本期只做管理员跨用户视角） |
| 翻译过程观测 | **完全空白**。只有一条 `llm_usage` 汇总 + 一条 `logger.warning` | 字段总数/译出数/未变化分组/生效 prompt 版本**均未落库** |
| `llm_usage` 台账 | 已写入（match / cover_letter / ai.* 共 29 条） | 无 `ai.translate` 任何记录；无读取接口 |
| 前端观测页 | analytics 页两 tab：`delivery`（投递）+ `matching`（匹配） | 无翻译维度 |

> 说明：本文档初版曾误判「匹配无页面」——起因是 `grep ... | grep -v match_observability` 把导入行一并过滤掉了。已用 ripgrep 重新核实。这类「管道里的二次过滤吃掉证据」的坑记入个人排查纪律。

**因此本期不是「新建观测页」，而是把翻译接到既有的 analytics 观测页上，用与 `MatchingObservability` 相同的 KPI / 图表 / 可展开明细模式**——用户已经熟悉这套界面，不需要第三套观测语言。

---

## 二、目标：页面必须能直接回答这 6 个问题

| # | 问题 | 现在 | 目标 |
| --- | --- | --- | --- |
| 1 | 这次翻译花了多少 token / 多久 / 成功吗 | 查库 | KPI + 明细行 |
| 2 | 翻译了多少字段，几个没译 | 猜 | `12 字段 → 10 译出 / 2 未变化` |
| 3 | 哪一类字段没译 | 猜 | 分组告警：`education 2/2 未变化` |
| 4 | 当时生效的是哪版翻译指令 | 不可能知道 | `prompt a3f9c1d2` |
| 5 | 匹配跑到哪一步、哪步慢 | 已有（用户侧） | 补管理员跨用户视角，复用同一时间线 |
| 6 | 最近的失败集中在哪个端点 | 翻日志 | 状态筛选 + 错误类型聚合 |

「prompt 版本」是本期的关键设计：本地化策略写在 prompt 字符串里，改了 prompt 行为没变、或没改却回归，**只有把生效版本记进台账才能对齐**。取 `sha256(TRANSLATE_SYSTEM)[:8]`，进程启动时算一次，零维护成本。

---

## 三、数据层方案（已裁决：扩展 `llm_usage`）

不新建第二套运行表：`llm_usage` 本来就是「一次业务调用一条」，且 match 也写它——一个查询接口即可覆盖全部端点。匹配的**过程**继续由 `match_run_steps` 承载，翻译是单步，用 `detail` 承载结果统计。

`llm_usage` 新增两列（SQLite `ADD COLUMN`，可空、老数据为空）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `prompt_version` | `String(16)`，默认 `""` | 生效 prompt 指纹 `sha256(...)[:8]` |
| `detail` | `Text`，默认 `""` | 端点自定义结构化摘要（JSON），**上限 8KB**，超限截断 |

翻译的 `detail`（**只存字段路径与计数，绝不存正文**）：

```json
{
  "targetLang": "en",
  "fieldsTotal": 12,
  "fieldsTranslated": 10,
  "fieldsUnchanged": 2,
  "unchangedGroups": { "education": 2 },
  "unchangedKeys": ["education.a.school", "education.b.school"]
}
```

约束：`unchangedKeys` 截断前 20 项；老记录无 detail → 页面显示「旧记录无明细」，不回填；迁移前必须备份 `jobmatch.db`（启动会自动 `upgrade head`）。

---

## 四、API 契约

| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/ai/translate/observability?days=` | 登录用户（只看自己） | KPI + 按日趋势 + 未变化分组分布 + 最近调用列表 |
| GET | `/api/ai/translate/observability/calls/{id}` | 同上（校验归属） | 单次详情：`detail` 解析 + token/耗时/prompt 版本 |
| GET | `/api/admin/ai/observability?days=&endpoint=` | 管理员 | 跨用户全局：按端点分布、失败率、错误类型、最近调用（翻译带摘要，匹配可下钻 steps） |

设计要点：

- 服务层单一函数 `compute_translation_observability(db, days, user_id: str | None)`，`user_id=None` 即全局，避免两套 SQL 漂移；
- `days` 复用既有白名单 `(7, 30, 90)`；
- 列表不返回 `detail` 全文，只返回摘要串（如 `12 字段 / 2 未变化`），详情按需拉取；
- 管理员端匹配下钻直接复用既有 `get_match_run_detail()`，不重写。

---

## 五、页面设计

### 5.1 用户侧（analytics 页新增第三 tab）

`analytics` 页已有 `delivery` / `matching` 两 tab，新增 `"ai"`（标签「AI 翻译」），第三项即 `TranslationObservability`，与 `MatchingObservability` 共用同一套原语（`Metric` / `Panel` 卡片、`workbench-panel analytics-panel` 类、`.xai-eyebrow` 小标签、`formatCount` / `formatRate`）：

1. KPI 5 卡：翻译次数 · 成功率 · 平均耗时（含 P95）· 未变化字段占比 · 总 token
2. 按日柱状（每日翻译次数）
3. 未变化分组分布（`education` / `projects` / `experience` …条形），**这是「为什么没译」的直接答案**
4. 最近调用列表：时间 / 目标语言 / 摘要（`12 字段 / 2 未变化`）/ 状态 / 耗时 → 点击展开：token、模型、prompt 版本、未变化 key 列表（按分组高亮）

### 5.2 管理员侧（admin 页新增区块）

admin 页已有 `TRAFFIC / USERS`、`PRODUCT / OUTPUT`、`GROWTH / ACTIVATION`、`READOUT / DAILY SIGNAL` 四段，且 `PRODUCT` 段已含 `llmCalls` + `totalTokens` 卡片。新增第五段 `AI / OBSERVABILITY`：

- 按端点分布（match / cover_letter / ai.translate / ai.grammar / ai.polish）
- 失败调用列表（错误类型 + 端点 + 时间）
- 最近调用表（跨用户，含 user_id 后 6 位脱敏）→ 翻译行下钻 detail，匹配行下钻 steps 时间线

### 5.3 视觉约束

沿用 Paper & Punch 与既有 analytics 令牌：纸底墨字、钴蓝唯一信号色、calm 密度细线卡片、状态色走语义令牌（`--green` / `--danger` / `--amber-ink`）。**禁写死色值**（`.analytics-header` 曾因写死奶油渐变在深色主题炸过）。

---

## 六、分阶段实施

| 阶段 | 交付物 | 验收 |
| --- | --- | --- |
| **P1 数据层** | `llm_usage` 两列 + 迁移；`track_llm`/`record_llm_usage` 增 `prompt_version`/`detail_ref`；`ai_proxy.summarize_translation()` 抽出为单一事实源（`_warn_if_group_unchanged` 复用）；`/api/ai/translate` 回填 | 真实翻译一次后，库中该行 `detail` 含字段统计、`prompt_version` 非空；`alembic current == heads`；迁移前已备份 db |
| **P2 服务与接口** | `services/ai_stats.py::compute_translation_observability`；用户侧 2 端点 + 管理员 1 端点；Pydantic 响应模型 | 单测：归属校验（他人记录 404）、`days` 白名单、空库零值、detail 非法 JSON 降级、聚合口径 |
| **P3 前端** | `TranslationObservability.tsx` + analytics 第三 tab + admin AI 段 + `lib/jobmatch.ts` 类型与 fetch + i18n（zh/en 双写） | 真实数据下 KPI/图/列表/展开均渲染；深色主题逐区核对；空态可达 |
| **P4 收尾** | 本文档「实现记录」+ `docs/README.md` 索引 + `PLAN_resume_translate.md` 补一节 | 后端全量 + 前端全量通过；文档与实现一致 |

---

## 七、测试矩阵

| 层 | 用例 |
| --- | --- |
| 数据层 | detail 超 8KB 截断且仍为合法 JSON；`unchangedKeys` 截 20 项；空 fields 不写 detail；异常时 `status=error` 仍落行 |
| 接口层 | 未登录 401；查他人记录 404；非管理员访问 admin 端点 403；`days=5` 422；空库返回零值而非 500 |
| 前端 | 摘要格式化纯函数（0 字段 / 全译出 / 全未变化 / 旧记录四态）；分组高亮与后端口径一致；tab 切换保持 `days` |
| 端到端 | 构造「英文学校名 + 中文目标」翻译一次 → 页面出现该行 → 展开见 2 个未变化字段 |

---

## 八、风险与约束

| 风险 | 处理 |
| --- | --- |
| 迁移触达生产库 | 迁移前 `cp jobmatch.db jobmatch.db.bak.<ts>`；`ADD COLUMN` 非破坏性 |
| detail 膨胀 | 8KB 硬上限 + key 截断；只存路径不存正文 |
| 隐私 | detail 无简历内容；管理员表内 user_id 截断展示 |
| 两套统计口径 | 翻译统计只由 `summarize_translation()` 产出，护栏与页面共用 |
| 深色主题 | 全部走令牌；新增组件不写死色值 |

---

## 九、与既有能力的关系

- **复用**：`MatchingObservability` 的视觉与交互模式、`match_stats.get_match_run_detail()`、`lib/jobmatch.ts` 的 `request()` 与 `AnalyticsDays`、analytics 页 tab 机制。
- **不新建**：不新增路由页、不新建运行表、不引入 OTel 等外部依赖（当前规模用不上，且会带来部署成本）。

---

## 十、评审结论（2026-10-29）

| # | 事项 | 裁决 |
| --- | --- | --- |
| 1 | 页面位置 | **复用既有可观测页面**（analytics 第三 tab），不新建路由 |
| 2 | 可见范围 | **管理员 + 普通用户** |
| 3 | 匹配过程时间线 | **一并做**（用户侧已有，补管理员跨用户视角） |
| 4 | 额外诊断（字符集检测等） | **不加**，detail 保持字段路径 + 计数 + 分组 + prompt 版本 |

---

## 十一、实现记录

### 11.1 数据层（P1）

- 迁移 `p8i0k2l4n6q8_add_llm_usage_detail.py`（`down_revision = f6a8c0e2d4b7`）：`llm_usage` 新增 `prompt_version`(String16) 与 `detail`(Text)，带 `server_default=""`。
- **已实际执行**：迁移前用 `sqlite3.backup()` 备份为 `jobmatch.db.bak.20261029120803`；`alembic upgrade head` 成功；`current == heads == p8i0k2l4n6q8`；`PRAGMA table_info(llm_usage)` 可见两列，既有行补齐空串。
- `ai_proxy.summarize_translation()` 为统计的单一事实源（`_warn_if_group_unchanged` 复用同一输出），新增 `TRANSLATE_PROMPT_VERSION = sha256(TRANSLATE_SYSTEM)[:8]`（当前 `16ef11b9`）。
- `usage.serialize_detail()` 分级降级：完整 → 丢 `unchangedKeys` 保计数 → 骨架 `{"truncated": true}`，任一级均为合法 JSON。
- `track_llm(..., prompt_version=, detail_ref=)`：`detail_ref` 用可变容器跨「调用之后」与「finally 落库」两个时点，`translate_fields` 签名不变。

### 11.2 接口（P2）

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| GET | `/api/ai/translate/observability` | `ai_stats.compute_translation_observability(user_id=user.id)` |
| GET | `/api/ai/translate/observability/calls/{id}` | `get_translation_call_detail`，他人记录 404 |
| GET | `/api/admin/ai/observability` | `compute_global_ai_observability`，`days` 白名单 + `endpoint` 白名单 |

### 11.3 前端（P3）

- `components/analytics/TranslationObservability.tsx`：KPI 5 卡 / 每日柱状 / 未变化分组分布 / 最近调用就地展开明细。
- `components/analytics/AdminAiSection.tsx`：admin 页第五段（统计卡 / 端点分布 / 失败清单 / 跨用户最近调用，user_id 只显后 6 位）。
- analytics 页新增第三个 tab（`?tab=ai`，URL 可直达）；`Metric`/`Panel` 从 `MatchingObservability` 导出复用，两块面板视觉同源。
- `lib/jobmatch.ts` 新增 3 个类型组与 3 个请求函数；`components/analytics/translation-scale.ts` 承载纯函数（可 node 测）。
- i18n：`analyticsTabAi` + 36 个 `translation*` + 10 个 `jobmatch.translationGroups.*` + 10 个 `adminAi*`，zh/en 双写。

### 11.4 与规划的三处差异

1. 列表接口返回 **summary 对象**而非预拼接字符串：文案要在 zh/en 下不同，字符串化必须在渲染层做。
2. `AdminAiSection` 的 `SectionLabel` **就地定义**，不从 `admin/page` 导入——page 会 import 该组件，反向导入会成循环依赖。
3. 未变化占比的分母取「已返回字段数」（`translated + unchanged`）而非 `fieldsTotal`：缺失字段由前端回退原文，混入分母会把「模型漏返回」误计为「策略性保留」。

### 11.5 验证证据

- 后端全量 **271 passed**（新增 `tests/test_ai_observability.py` 17 例：统计分桶、序列化降级、路由接线、观测接口权限与口径）。
- 前端全量 **236 passed**（29 文件；新增 `tests/translation-observability.test.ts` 9 例）。
- `tsc --noEmit`：新增文件零报错（31 行报错均为既有 `tests/` 用例的类型宽松问题）。
- **端到端**（临时库 + 真实模型，不触生产数据）：提交 5 个字段翻译成中文后，观测接口返回
  `fieldsTotal=5 / translated=3 / unchanged=2`，`unchangedGroups={projects:1, experience:1}`，
  未变化 key 为 `projects.b.name`（`JD-Match` 纯代号）与 `experience.a.company`（`ByteDance` 公司名），
  `prompt_version=16ef11b9`，耗时 1084ms / 860 tokens。即：**「哪类字段没译、为什么没译」已可在页面上直接读懂**。
- 临时库与脚本均已清理，生产库仅新增两列（无业务数据改动）。
