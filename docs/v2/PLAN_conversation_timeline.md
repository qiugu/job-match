# PLAN：以岗位卡为轴的「对话式时间线」改造方案

> 状态：**已归档（废弃）**。本文方向（时间线）已被 `PLAN_conversation_memory.md` 取代——用户明确需求是「对话记录 + 对话式入口」，而非时间线回看。
> 结论：方向正确，但落点应是**以 Job 为容器的活动时间线**，而非独立的自由对话 Agent。

---

## 0. 一句话结论

把「话术 + 匹配记录」从当前**三段平铺的资源视图**，重构成**一条围绕岗位卡的时间线（activity timeline）**，每条记录可展开、可二次编辑、可重新生成并保留历史版本。视觉上接近聊天流，数据模型仍是强类型资源，不引入自由对话系统。

---

## 1. 现状与问题诊断

### 1.1 已有资产（勿重复建设）

| 资源 | 模型 | 落库粒度 | 缺口 |
|---|---|---|---|
| 话术 | `CoverLetter` | 每次生成/重生成都落库，含 resume/jd 快照、scene、时间 | `regenerate` 原地覆盖 `content`，**历史版本丢失** |
| 匹配结果 | `DerivedResume` | 每次匹配落库，含 markdown、analysis_json、keywords | 同一 JD 多次匹配产生**并列记录**，无版本线 |
| 状态事件 | `JobStatusEvent` | append-only，记录 from→to 与时间 | 已具备，但未用于展示时间线 |
| 运行台账 | `MatchRun`/`Trace`/`Span` | 完整可观测性链路 | 面向内部审计，非用户可读流 |

**核心判断**：问题不是「没存下来」，而是「缺少一个连贯的容器视图 + 版本语义」。

### 1.2 前端现状（`frontend/src/app/app/dashboard/jobs/page.tsx`）

岗位详情抽屉 `JobDetailView` 当前把内容分三段平铺：

1. 岗位描述（JD）→ `<section>` 锚点
2. 定制简历（`detail.derived_resumes`）→ `DerivedCard[]`
3. 话术记录（`detail.cover_letters`）→ `PitchCard[]`

三个 section 相互独立、各按自己的 `created_at` 排序，**无法体现「打招呼 → 改简历 → 投递 → 跟进」这条真实求职推进叙事**。这正是改造的落点。

---

## 2. 产品合理性判断（成熟产品参照）

| 形态 | 代表产品 | 与本品契合度 | 结论 |
|---|---|---|---|
| 任务型（单次请求=单次结果） | ChatGPT 单条请求 | 当前形态，已完整 | 保留为「发起新操作」入口 |
| 会话型（自由多轮对话） | ChatGPT/Claude 会话 | **低** | 引入后打穿积分计费、状态机、上下文管理，复杂度收益比差 |
| 业务对象型（实体容器 + 活动流） | Notion/Linear/Monday、成熟 ATS | **高** | 与现有 `Job` 容器天然契合，是正确方向 |

**结论：方案 B（业务对象型活动流）是正解。**

关键理由：
1. 用户真实任务是「求职流程推进」，非「与 AI 闲聊」，operation-driven 状态机已精确建模此流程。
2. 「聊天式」真正有价值的子集是**迭代 refinement**（换个语气/更简洁/更正式），可用已有 `regenerate` 端点承载，缺的只是「保留版本」。
3. 自由对话会破坏「每次操作 = 一次积分扣减」的清晰计费模型，并重开「用户绕过流程自由操作」的口子，污染刚建立的 operation-driven 状态机语义。

---

## 3. 方案设计

### 3.1 核心原则

- **Job 是唯一时间线轴心**：所有话术/匹配/状态事件按 `job_id` 聚合为一条时间线。
- **零新「消息」模型**：不引入 `Conversation`/`Message` 自由对话表；时间线条目由现有资源 + 状态事件推导。
- **版本语义最小化**：只给 `CoverLetter` 加版本链，`DerivedResume` 沿用「同 job 多记录 + accepted 标记」作为事实上的版本，不强制单当前版。
- **积分与状态机不动**：迭代仍走 `regenerate`，仍扣 `cover_letter_cost`/`resume_match_cost`，仍触发 `promote_for_action`。

### 3.2 数据模型变更（仅一处新增）

新增 `cover_letter_versions` 表（append-only，同 `job_status_events` 范式）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | String(32) PK | uuid |
| cover_letter_id | String(32) | 归属话术（FK → cover_letters，ondelete=CASCADE） |
| content | Text | 该版本正文 |
| model | String(64) | 生成模型（审计） |
| created_at | DateTime | 版本生成时刻 |

语义：`CoverLetter.content` 始终指向**最新版**（读路径不变，零迁移破坏）；`regenerate` 时先插入一条旧版本快照，再更新 `content`。删除话术级联删除其全部版本。

> `DerivedResume` 不新建版本表：同一 `job_id` 下多次匹配天然是并列记录，`accepted` 已标记「当前采纳」。若要更强版本语义，可后续加 `DerivedResume.previous_id` 链式指针，本期不做。

### 3.3 API 变更

| 端点 | 变更 |
|---|---|
| `GET /api/jobs/{id}` | 返回体新增 `timeline` 字段（见 3.4），或保持现状 + 新增独立 `GET /api/jobs/{id}/timeline` |
| `POST /api/cover-letters/{id}/regenerate` | 生成前快照旧 `content` 到 `cover_letter_versions` |
| `GET /api/cover-letters/{id}/versions`（新增） | 返回该话术的历史版本列表，供回看/回滚 |

> 建议采用独立 `timeline` 端点而非塞进 `GET /jobs/{id}`：详情页已有 `derived_resumes`/`cover_letters` 两路数据，加第三路会让单接口膨胀；独立端点可懒加载、按需翻页。

### 3.4 时间线数据契约

`GET /api/jobs/{id}/timeline` 返回按时间升序的混合条目：

```jsonc
{
  "items": [
    { "type": "cover_letter", "id": "...", "scene": "greeting", "content": "...",
      "created_at": "...", "versions_count": 3 },
    { "type": "derived_resume", "id": "...", "title": "...", "accepted": false,
      "score": 0.82, "summary": "...", "created_at": "..." },
    { "type": "status_event", "source": "manual", "from": "resume_ready",
      "to": "applied", "occurred_at": "..." },
    { "type": "cover_letter", "id": "...", "scene": "followup", "content": "...",
      "created_at": "...", "versions_count": 1 }
  ]
}
```

三条数据源按各自时间字段合并排序：
- 话术 → `cover_letters.created_at`
- 匹配结果 → `derived_resumes.created_at`
- 状态事件 → `job_status_events.occurred_at`

### 3.5 前端交互（岗位详情抽屉重构）

把 `JobDetailView` 的三个平铺 section 替换为一条时间线：

- **时间线卡片流**：条目按类型渲染（话术卡片 / 简历卡片 / 状态里程碑徽章），视觉上接近聊天流。
- **话术卡片**：正文 + `scene` 徽章 + 相对时间 + 两个动作——「换措辞重新生成」（走 regenerate）+「查看历史版本」（展开版本列表，可回滚到某版本）。
- **简历卡片**：沿用现有 `DerivedCard`（含匹配分析、得分、全文折叠），新增「重新匹配」入口。
- **状态里程碑**：以 `JobStatusEvent` 渲染为时间线上的分隔节点（如「已投递」「已归档」）。
- **JD 锚点**：JD 固定在时间线顶部（上下文锚点），不参与排序。

> 视觉目标：满足用户「聊天式」诉求，但数据模型与积分体系零破坏。

---

## 4. 实施步骤（评审通过后执行）

| 步骤 | 内容 | 交付物 |
|---|---|---|
| 1 | 新增 `CoverLetterVersion` 模型 + Alembic 迁移 | 迁移文件 + 已生效库 |
| 2 | `regenerate` 加版本快照；新增 versions 端点 | 后端代码 |
| 3 | 新增 `GET /jobs/{id}/timeline` 聚合端点 | 后端代码 + schema |
| 4 | 前端 `JobDetailView` 重构为时间线视图 | 前端代码 |
| 5 | 单元测试（版本链、timeline 聚合、归属校验） | 测试 |
| 6 | 代码审查（可读性/性能/安全/风格） | 审查结论 |

---

## 5. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| `regenerate` 语义变化（覆盖→追加） | 现有用户习惯覆盖 | 读路径不变，仅内部追加版本，对旧客户端透明 |
| 时间线接口混合三源排序性能 | SQLite 下三表 union 排序 | 单岗位数据量小（<百条），内存排序即可；后续可按时间索引 |
| 状态事件回填 | 存量岗位卡无历史事件 | 沿用 `EVENT_SOURCE_BACKFILL` 已确立的回填范式，前端斜纹标注 |
| 版本表膨胀 | 高频重生成累积 | 仅存正文文本，体积可控；可加单话术版本上限 |
| 越权/归属 | 多用户数据隔离 | timeline 端点必须按 `job.user_id` 校验（沿用 `_ensure_owner` 范式） |

---

## 6. 明确不做（本期范围外）

- ❌ 自由对话 `Conversation`/`Message` 模型与流式输出
- ❌ 基于上文的任意追问（仅保留「换措辞」这一有限 refinement）
- ❌ `DerivedResume` 版本链指针（`previous_id`）
- ❌ 积分体系重构（迭代仍按次扣减）
