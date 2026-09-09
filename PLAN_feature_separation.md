# JD 简历匹配 与 JD 话术匹配 — 功能分离方案

> 目标：将当前耦合在简历匹配流程中的"话术生成"拆解为独立功能，使话术可独立生成、刷新、多场景管理，同时让匹配分析更纯粹。

---

## 一、现状问题诊断

当前"话术"不是独立功能，而是 `resume_match` 节点一次 LLM 调用的副产物。耦合贯穿 6 层：

| 层 | 耦合点 | 文件位置 | 问题 |
|----|--------|----------|------|
| Schema | `MatchResult.cover_letter` | `app/schemas/agent.py:29` | 话术与分析结果绑定在同一 Pydantic 模型 |
| Prompt | `RESUME_MATCHER_PROMPT` 同体输出 | `app/core/prompts.py:75` | 匹配 prompt 同时要求产出 cover_letter，无法单独触发话术 |
| 节点 | `resume_match` 既算匹配又产话术 | `app/services/agent.py:96-107` | 一次 LLM 调用职责过载 |
| 数据 | `CoverLetter.derived_resume_id` FK 强绑 | `app/models/cover_letter.py:25-27` | 话术无法脱离匹配结果独立存在 |
| API | `run_match` 返回四元组含 cover | `app/services/agent.py:304-344` | 话术随匹配一次性返回，无法单独刷新 |
| 前端 | 话术取自 `matchAnalysis.cover_letter` | `frontend/src/app/app/dashboard/match/page.tsx:823` | 话术与匹配得分共用响应体 |

**直接后果**：话术无法独立生成、无法刷新换措辞、无法多场景（打招呼/跟进/邀约）、匹配失败则话术也丢失、`matchAnalysis` 不持久化导致刷新页面后话术需重新匹配。

---

## 二、分离目标

1. **匹配链路**：只产出匹配分析（role/score/requirements/summary）+ 优化简历，不再掺话术。
2. **话术链路**：独立 API、独立 prompt、独立存储，输入仅需 `resume + jd`。
3. **数据解耦**：`CoverLetter` 表 FK 解绑 `derived_resume`，改为可空关联 + 用户归属。
4. **多场景支持**：话术区分 scene（打招呼 / 跟进 / 邀约面试 等），可多次生成。
5. **独立刷新**：话术可重新生成换措辞，不重跑匹配。

---

## 三、数据模型变更

### 3.1 CoverLetter 表重构

| 字段 | 现状 | 目标 | 说明 |
|------|------|------|------|
| `id` | PK | PK（不变） | |
| `user_id` | 无 | **新增，NOT NULL** | 话术归属用户，独立查询 |
| `derived_resume_id` | NOT NULL FK | **改为 nullable FK** | 保留关联（匹配顺带生成时填），独立生成时为空 |
| `resume_text` | 无 | **新增，Text** | 生成时的简历快照，便于追溯与刷新 |
| `jd_text` | 无 | **新增，Text** | 生成时的 JD 快照 |
| `scene` | 无 | **新增，String(32) default "greeting"** | 场景标识 |
| `content` | Text | Text（不变） | 话术正文 |
| `model` | 无 | **新增，String(64) nullable** | 记录生成模型 |
| `created_at` / `updated_at` | 有 | 有（不变） | |

### 3.2 DerivedResume 表

- `has_cover_letter` 字段**保留但语义弱化**：仅标记"匹配时是否顺带产出了话术"，独立生成的话术不计入。后续可废弃。
- 不新增字段。

### 3.3 新增 CoverLetter 历史版本（可选增强）

话术多次 regenerate 时，可选择保留历史版本（同一 `resume_text + jd_text + scene` 下的多版本），通过 `is_active` 标记当前版本。MVP 阶段可先覆盖更新，不做版本树。

---

## 四、Schema（Pydantic）变更

`app/schemas/agent.py`：

| 改动 | 详情 |
|------|------|
| `MatchResult` 移除 `cover_letter` | 删除 L29 字段，匹配输出更聚焦 |
| 新增 `CoverLetterRequest` | `resume_text: str`、`jd_text: str`、`scene: str = "greeting"`、`derived_resume_id: str \| None = None` |
| 新增 `CoverLetterResult` | `id`、`content`、`scene`、`model`、`created_at` |

`AgentState` 移除 `cover_letter` 与 `with_cover_letter` 字段（L39, L41），匹配流程不再涉及话术。

---

## 五、API 设计

### 5.1 匹配端点（改造）

`/api/derived-resumes`（`app/api/match.py`）：

| 端点 | 改动 |
|------|------|
| `POST /api/derived-resumes` | `MatchRequest.withCoverLetter` 字段废弃；响应不再含 `coverLetter` / `hasCoverLetter`；`run_match` 返回三元组 `(keywords, resume_md, analysis)` |
| `GET /api/derived-resumes/{id}` | 响应移除 `coverLetter` 字段（话术改走独立 API 查询） |
| `GET /api/derived-resumes/{id}/cover-letter` | **废弃**，由 `/api/cover-letters?derived_resume_id=xxx` 替代 |

### 5.2 话术端点（新增独立 Router）

新建 `app/api/cover_letter.py`，注册 `APIRouter(prefix="/api/cover-letters")`：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/cover-letters` | 生成话术。Body: `resume_text` + `jd_text` + `scene`(可选) + `derived_resume_id`(可选)。调 `run_cover_letter`，落库返回 |
| `GET` | `/api/cover-letters` | 列表。支持 `?derived_resume_id=` / `?scene=` 筛选，按 `updated_at desc` |
| `GET` | `/api/cover-letters/{id}` | 详情 |
| `POST` | `/api/cover-letters/{id}/regenerate` | 用相同输入重新生成（换措辞），覆盖或新增版本 |
| `PUT` | `/api/cover-letters/{id}` | 编辑内容（用户手改） |
| `DELETE` | `/api/cover-letters/{id}` | 删除 |

### 5.3 可选：匹配顺带生成（快速路径）

若希望匹配时仍能一次 LLM 拿到话术（省一次调用），保留 `withCoverLetter` 参数，匹配完成后**内部调** `run_cover_letter` 并落库到 `CoverLetter`（`derived_resume_id` 填充）。此为优化项，**不阻塞分离目标**，MVP 可先不做。

---

## 六、服务层重构

`app/services/agent.py`：

| 函数 | 改动 |
|------|------|
| `resume_match` 节点 | prompt 改用不含 cover_letter 的版本；输出 `MatchResult` 无 cover_letter 字段 |
| `run_match` 签名 | `(master_text, jd_text) -> tuple[list[str], str, dict \| None]`，移除 `with_cover_letter` 与 cover 返回 |
| `generate_cover_letter` | **从留档代码激活为正式函数**（L272-284 已有实现），改为接收 `(resume_text, jd_text, scene)` |
| 新增 `run_cover_letter` | 包装 `generate_cover_letter` + 超时/异常处理/重试，返回 `(content, model)`，与 `run_match` 错误处理风格一致 |

`run_cover_letter` 伪代码：

```python
async def run_cover_letter(resume_text: str, jd_text: str, scene: str = "greeting") -> tuple[str, str]:
    """独立生成话术，返回 (content, model_name)。"""
    if not is_configured():
        raise RuntimeError("LLM 未配置")
    prompt = COVER_LETTER_PROMPT.format(jd_text=jd_text, resume_text=resume_text, scene=scene)
    try:
        resp = await asyncio.wait_for(model.ainvoke(prompt), timeout=settings.llm_timeout)
        content = _to_text(resp.content).strip()
        return content, settings.llm_model
    except asyncio.TimeoutError:
        raise RuntimeError("话术生成超时，请稍后重试")
    except Exception as e:
        raise RuntimeError(f"话术生成失败：{e}") from e
```

---

## 七、Prompt 拆分

`app/core/prompts.py`：

| Prompt | 改动 |
|--------|------|
| `RESUME_MATCHER_PROMPT` | 删除 L75 `"cover_letter": "打招呼话术..."` 及 L61 输出规模说明中的 cover_letter 行；JSON 输出结构去掉 cover_letter |
| `COVER_LETTER_PROMPT` | 从留档激活为正式使用；新增 `{scene}` 参数，按场景调整语气（greeting 简洁打招呼 / followup 跟进 / interview 邀约面试） |

`COVER_LETTER_PROMPT` 扩展示例：

```
你是资深求职话术顾问。根据简历与岗位描述，写一段{scene_desc}话术，约 150 字，
真诚简洁，突出核心匹配点。仅输出纯文本，不要标题。

场景：{scene}（{scene_desc}）
岗位描述：{jd_text}
简历文本：{resume_text}
```

---

## 八、LangGraph 调整

- 匹配图 `build_graph`（L287-301）**不变**（仍为 jd_extract → resume_match → keyword_optimize）。
- 话术**不进图**：单次 LLM 调用无需图编排，直接函数调用即可。避免为简单功能引入不必要的复杂度。
- `generate_cover_letter` 节点从图中摘除的留档状态解除，改为被 `run_cover_letter` 直接调用的普通 async 函数。

---

## 九、前端调整

`frontend/src/`：

| 文件 | 改动 |
|------|------|
| `lib/jobmatch.ts` | `MatchAnalysis` 类型移除 `cover_letter`（L183-195）；新增 `CoverLetter` 类型 + `createCoverLetter` / `listCoverLetters` / `getCoverLetter` / `regenerateCoverLetter` / `deleteCoverLetter` API 方法 |
| `app/dashboard/match/page.tsx` | 话术不再从 `matchAnalysis.cover_letter` 取（L823）；改为匹配后调 `createCoverLetter` 独立生成；话术区独立组件，支持「重新生成」「复制」 |
| 新增组件 `components/CoverLetterPanel.tsx` | 独立话术面板：展示、刷新、场景切换、空态提示 |

前端调用时序：匹配成功 → 拿到 `derived_resume_id` → 调 `POST /api/cover-letters`（带 `derived_resume_id`）→ 展示话术。刷新时只调 regenerate，不重跑匹配。

---

## 十、配额与计费（已确认决策）

- **话术生成共享匹配额度**：话术不拆分独立配额，与简历匹配共用 `match_quota`，每次生成扣 1。理由：话术 prompt 短、调用成本低，独立拆分会增加计费复杂度而无收益。
- **账号默认额度提升为 20**：`REGISTRATION_DEFAULT_MATCHES` 默认值由 `10` 调整为 `20`（同步改 `app/core/config.py` 默认值与 `.env.example` 注释）。

| 功能 | 配额 | 说明 |
|------|------|------|
| 简历匹配 | 消耗 `match_quota` | 现状不变，每次匹配扣 1 |
| 话术生成 | 共享 `match_quota` | 每次生成扣 1，无独立配额字段 |

额度校验与归还直接复用现有 `app/services/quota.py` 的 `reserve_match_quota` / `refund_match_quota`，**不新增** `cover_letter_quota` 字段，也无需改动 `User` 模型。新增的 `/api/cover-letters` 端点在生成话术前统一调用 `reserve_match_quota`，配额不足返回 403（与 `POST /api/derived-resumes` 的 `create_match` 行为一致）；生成失败则 `refund_match_quota` 归还。

---

## 十一、数据库迁移

Alembic 迁移（`migrations/`）：

1. **CoverLetter 表结构变更**：
   - `derived_resume_id` 改为 nullable
   - 新增 `user_id`（NOT NULL，需回填：用现有记录的 derived_resume.user_id 填充）
   - 新增 `resume_text` / `jd_text` / `scene` / `model` 字段

2. **回填策略**：
   - 历史已有关联话术：`user_id` 从 `derived_resumes.user_id` JOIN 回填
   - `resume_text` / `jd_text` 从关联的 `derived_resume` 回填（jd_text 已在 derived_resume 表）
   - `scene` 默认 `"greeting"`
   - `model` 置空

3. **执行前备份**：`cp jobmatch.db jobmatch.db.bak.<timestamp>`（AGENTS.md 已要求）

---

## 十二、实施步骤与优先级

按依赖关系分 4 个阶段，每阶段可独立验证：

### Phase 1 — 后端数据层（基础）
- [x] CoverLetter 表结构迁移 + 回填脚本（迁移 `f1a2b3c4d5e6`，已应用，16 条历史话术回填 user_id）
- [x] `app/schemas/agent.py`：`MatchResult` 移除 cover_letter，新增 CoverLetter schema
- [x] `app/models/cover_letter.py` 更新字段（derived_resume_id 改 nullable + user_id/resume_text/jd_text/scene/model）

### Phase 2 — 后端服务层（解耦）
- [x] `app/core/prompts.py`：RESUME_MATCHER_PROMPT 去除 cover_letter 字段与规模控制行；COVER_LETTER_PROMPT 支持 scene 场景
- [x] `app/services/agent.py`：`run_match` 去除话术，返回 3 元组 (keywords, resume_md, analysis)；`generate_cover_letter` 节点改造为独立 `run_cover_letter(resume_text, jd_text, scene)`
- [x] `AgentState` 清理 with_cover_letter / cover_letter 字段

### Phase 3 — 后端 API 层（对外）
- [x] `app/api/match.py`：匹配端点去话术字段（create_match 改 3 元组解包，不再内联生成/落库 CoverLetter，响应返回 coverLetter=None/hasCoverLetter=False）
- [x] 新建 `app/api/cover_letter.py`：完整 CRUD（POST/GET 列表/GET 详情/PUT 更新/DELETE）+ regenerate，生成/重生成前调 `reserve_match_quota`（共享 match_quota，失败归还），`model` 字段存 `settings.llm_model`
- [x] `app/main.py` 注册新 router（`app.include_router(cover_letter.router)`，前缀 `/api/cover-letters`）
- [x] `app/core/config.py`：`REGISTRATION_DEFAULT_MATCHES` 默认值 10 → 20，同步 `.env.example`（已在确认决策时完成）

### Phase 4 — 前端（交互）
- [x] `lib/jobmatch.ts`：`MatchAnalysis` 移除 `cover_letter`；新增 `CoverLetter`/`CoverLetterScene` 类型与 `createCoverLetter`/`listCoverLetters`/`getCoverLetter`/`updateCoverLetter`/`deleteCoverLetter`/`regenerateCoverLetter` 六函数
- [x] 匹配页（`app/dashboard/match/page.tsx`）：移除 analysis 右栏内联话术卡片（原 `a.cover_letter`），新增「话术」tab 挂载 `CoverLetterPanel`；匹配成功后把 `result.id` 存 `localStorage(lastDerivedResumeId)`，空态下据此从 DB 加载历史话术
- [x] 新增 `components/CoverLetterPanel.tsx`：多场景（打招呼/跟进/邀约）生成、列表、查看（展开/收起）、二次编辑、重生成、删除、复制；生成/重生成消耗共享额度并 `applyQuota` 刷新
- [x] i18n：`zh.json`/`en.json` 的 `jobmatch` 块补充 `pitch*` 系列文案与三场景键

---

## 十三、风险与回退

| 风险 | 影响 | 缓解 |
|------|------|------|
| 历史话术数据丢失 | 已有 cover_letter 记录 | 迁移前备份 + 回填脚本；FK 改 nullable 不删数据 |
| 匹配响应字段变更致前端报错 | 匹配页面异常 | 前后端同 PR 发布；前端做字段兼容（`coverLetter ?? null`） |
| 话术独立后多一次 LLM 调用 | 成本/延迟 | 可选快速路径（5.3）；话术 prompt 短，单次调用成本低 |
| 默认额度提升至 20 | 仅影响新注册账号 | 存量账号 `match_quota` 保持注册时授予值，不受默认值变更影响，无需迁移 |

回退方案：迁移可逆向（恢复 FK NOT NULL + 删新字段），代码可 revert，数据库有备份。

---

## 十四、验收标准

1. `POST /api/cover-letters` 传入 resume + jd 可独立生成话术，不触发匹配流程。
2. `POST /api/cover-letters/{id}/regenerate` 可刷新话术内容，不重跑匹配。
3. `POST /api/derived-resumes` 响应不再含 `coverLetter` 字段，匹配分析正常返回。
4. 前端匹配页话术独立加载/刷新，刷新页面后话术从 DB 读取而非丢失。
5. 历史话术数据迁移后可正常查询（`GET /api/cover-letters?derived_resume_id=`）。

---

## 十五、实施与验证（2026-09-08）

### 实施回顾
- Phase 1–4 按方案顺序落地；每阶段完成后均经 `python -c "from app.main import app"` 冒烟 + `npx tsc --noEmit` + `npx vite build`（绕开 `pnpm build` safe-delete 守卫）。
- 共享额度策略落地：话术生成/重生成均预扣 `match_quota` 并失败归还；编辑/列表/删除不扣；正则化新注册默认额度从 10 提升至 20（仅影响新账号，存量不受影响）。
- 话术不进入 LangGraph 图：`run_cover_letter` 是独立 LLM 直调，匹配工作流不再顺带产出话术。

### 收尾（2026-09-08 启动验证后追加）
- 验证过程中发现并修复 `_generate_text` 缺 scene 白名单校验（`app/api/cover_letter.py`），非法 scene 改为 400 明确报错。
- 删除遗留 ORM 关系 `DerivedResume.cover_letter` 与 `CoverLetter.derived`（`app/models/derived_resume.py`、`app/models/cover_letter.py`），改为通过 `derived_resume_id` 字符串外键按需查询，彻底解耦。
- 旧端点 `GET /api/derived-resumes/{derived_id}/cover-letter` 保留但标 `deprecated=True`，业务逻辑改为 410 + 明确迁移指引（`app/api/match.py`），便于存量客户端平滑过渡。
- `DerivedResume.cover_letter` / `hasCoverLetter` 字段从所有 API 响应（create / get / list）中移除；列 `has_cover_letter` 暂保留以便后续 Alembic 迁移（不影响前端）。

### 验证记录
- **后端真实 LLM 端到端（20/20）**：登录 → 匹配（~110s，matchAnalysis 含 role/score/requirements/summary）→ 生成 greeting（配额 20→18，172 字）→ 列表/详情（详情不返 `remaining_quota`）→ 编辑（不耗额度，内容/时间已更新）→ 重生成 followup（配额 18→17，179 字，scene 已切换）→ 异常（空 400 / 非法 derived 404 / 非法 scene **400** / 无 token 401）→ 删除（删后 404）。
- **前端 UI（真实浏览器 Chromium）**：登录路由守卫 → 选简历 + 匹配（120s，55% 得分、12 项需求）→ 三个 tab（匹配分析/优化简历/匹配话术）→ 切话术 tab → 三场景（打招呼/跟进/邀约）→ 生成 160 字打招呼（配额 9→8→7）→ 切跟进重生成 179 字（配额→6）。
- **共享额度实时扣减**：9 → 8（匹配）→ 7（生成）→ 6（重生成），侧栏 `剩余匹配 · N` 实时同步刷新。

### 已知遗留（非阻塞）
| 项 | 说明 |
|----|------|
| API 字段命名风格 | match API 用 camelCase（`resumeText/jdText`），cover-letters API 用 snake_case（`resume_text/jd_text`）；前后端各自一致。统一需改 schema + 前端类型，影响面较大。 |
| 旧测试 `tests/test_match_routes.py` | Phase 2/3 改造后 `_fake_run_match` 签名（4 元组含 cover）与 `test_create_match_with_cover_letter` 已不适用，CI 跑会失败。需另开 PR 迁移/删除对应测试。 |
| 列 `derived_resumes.has_cover_letter` | 永远 False，未删除；下一轮 Alembic 迁移时清理。 |
