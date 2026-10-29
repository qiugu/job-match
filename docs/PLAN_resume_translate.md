# PLAN：简历翻译（Resume Translate）

> 状态：**已实现**（2026-10-28，代码 + 测试全绿；目标语言裁决为仅中/英）
> 日期：2026-10-28
> 范围：PreviewDock 新增「翻译简历」入口 + 后端 `/api/ai/translate` + 落地「覆盖当前 / 新建简历」

---

## 1. 需求

在简历编辑页右侧 `PreviewDock` 增加「翻译简历」按钮：

1. 选择目标语言，将整份简历翻译为指定语言版本；
2. 落地方式二选一：**覆盖当前简历** 或 **新建简历**（原简历保留）。

---

## 2. 核心设计决策（最佳实践论证）

### 2.1 翻译载荷采用「键值映射」而非整包 JSON 回传

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. 整包 `ResumeData` 发给 LLM 回传 | 与 `resume-import` 同路 | ❌ 弃：`templateId`/`globalSettings`/`photoConfig`/IDs/日期等非文本配置易被 LLM 篡改或丢字段，配置损坏代价高且难约束 |
| B. 仅按当前编辑模式翻译（markdown 或结构化二选一） | — | ❌ 弃：工作台双模式（`editMode: form \| markdown`）并存，两路实现重复、模式切换后出现「译了一半」 |
| **C. 提取可翻译文本字段 → 扁平 `key → value` 映射，LLM 只译值、原样回传 key，前端按 key 合并** | 推荐 | ✅ 非文本字段从不离开客户端，LLM 物理上无法破坏结构；缺失 key 自动回退原文（部分成功可用）；extract/merge 为纯函数可单测；输出可 diff |

### 2.2 翻译字段清单（extract 的 key 路径）

| 路径 | 说明 | 备注 |
| --- | --- | --- |
| `title` | 简历标题 | |
| `basic.name/title/location/employementStatus` | 姓名/职位/地点/求职状态 | 人名处理见 2.4 |
| `basic.customFields.{id}.label/value` | 自定义字段 | |
| `education.{id}.school/major/degree/description` | 教育经历 | `gpa`、日期原样保留 |
| `experience.{id}.company/position/details` | 工作经历 | `details` 为 markdown 多行 |
| `projects.{id}.name/role/description/linkLabel` | 项目经历 | `link` URL 原样保留 |
| `skillContent` / `selfEvaluationContent` | 技能 / 自我评价 | markdown |
| `customData.{sectionId}.{itemId}.title/subtitle/description` | 自定义模块条目 | |
| `menuSections.{id}.title` | 模块标题（「工作经历」→「Experience」） | |
| `markdownContent` | Markdown 模式正文（若存在） | 结构标记原样保留 |

不译字段（永不发送）：所有 id、`createdAt/updatedAt`、`templateId`、`globalSettings`、`photoConfig`、日期字符串、`gpa`、邮箱/电话/URL、`certificates`、`menuSections` 的 order/enabled/icon。

### 2.3 目标语言

**裁决（用户 2026-10-28）：本期仅支持简体中文 / English**（常量 `TRANSLATE_LANGUAGES`，前后端白名单同源：前端 `lib/resumeTranslate.ts`、后端 `ai_proxy.TRANSLATE_LANGUAGES`）。其余语种待后续需求再扩充。

### 2.4 专名与人名约定（写入 LLM Prompt 硬约束）

- 公司名、学校名、产品名等**专名保留原文**（可选括注译文不做，保持简历克制）；
- 人名保留原文；中→英场景允许按拼音转写（如「张三」→「Zhang San」）；
- 日期、数字、度量、邮箱、电话、URL 原样保留；
- Markdown 结构（`#`/`##`/`-`/`**`/`:::left|center|right` 容器）逐字符保留，只译文字。

### 2.5 积分策略

**不扣积分**（与 `polish` / `grammar` / `resume-import` 一致），仅通过 `track_llm` 记入 LLM 用量台账（Plan.md R1/R2 体系）。新增端点常量 `ENDPOINT_AI_TRANSLATE = "ai.translate"`。

> 若后续希望翻译计费，可在 `services/quota.py` 挂 `RESUME_TRANSLATE_COST`，接口层预留兼容；本期不做。

---

## 3. 后端实现

### 3.1 `app/services/ai_proxy.py`

- 新增 `TRANSLATE_SYSTEM` prompt（含 2.4 全部硬约束 + JSON 键原样回传约束）；
- 新增 `async def translate_fields(fields: dict[str, str], target_lang: str) -> dict[str, str]`：
  - `get_llm(temperature=0)` + `response_format={"type": "json_object"}`（与 `grammar_check` 同路）；
  - 复用 `_extract_json` 容错解析；
  - 返回 `{key: 译文}`，只回传输入中出现过的 key（多余 key 丢弃）。

### 3.2 `app/api/ai.py`

```http
POST /api/ai/translate
请求: { "targetLang": "en", "fields": { "title": "我的简历", "skillContent": "...", ... } }
响应: { "fields": { "title": "My Resume", ... } }      # 成功
      { "error": { "message": "..." } }                # 失败（与 grammar 一致）
```

- 鉴权：`Depends(get_current_user)`（与现有 AI 路由一致）；
- 入参校验：`targetLang` 白名单；`fields` 非空、value 均为字符串、总长度上限（复用 `PDF_EXPORT_MAX_HTML_BYTES` 量级或独立 256KB 上限）；
- 用量：`async with track_llm(ENDPOINT_AI_TRANSLATE, user_id=user.id)`；
- 错误处理：`RuntimeError`（LLM 未配置）→ `{"error": {"code": "ConfigError"}}`；其他异常 → 500 风格 error JSON（对齐 `grammar` 现状）。

### 3.3 `app/models/llm_usage.py`

新增 `ENDPOINT_AI_TRANSLATE = "ai.translate"`。

---

## 4. 前端实现

### 4.1 `PreviewDock.tsx` — 入口按钮

- 图标：lucide `Languages`；位置：第一组「复制简历」之后（与模板/导出/复制同属「操作简历正文」一类）；
- 样式：沿用 `DOCK_BUTTON_CLASS`（28px chip，Paper & Punch 令牌），不引入新体量；
- 行为：打开 `TranslateDialog`（本地 state 控制，与 `GrammarCheckDrawer` 的事件总线不同——翻译对话框无跨组件需求，直挂 Dock 即可）。

### 4.2 `components/preview/TranslateDialog.tsx` — 翻译对话框（新）

设计基调遵循 `docs/DESIGN.md`（Paper & Punch）：纸底卡片、墨色文字、钴蓝仅用于主操作按钮、硬偏移阴影 `4px 4px 0`、无 blur。

表单结构：

1. **目标语言** Select（仅简体中文 / English，默认 English）
2. **落地方式** Radio 二选一：
   - `覆盖当前简历`（默认）——提示文案：「覆盖后可用撤销恢复」（`updateResume` 走 history，undo 可回退）；
   - `新建简历`——展开标题输入框，默认建议 `原标题 · English`（语言名取 Select 显示名）
3. **确认按钮**（钴蓝）→ loading（`Loader2` + 「正在翻译…」，禁用表单防重复提交）→ 成功：
   - 覆盖模式：合并译文 → 主动 `syncResumeToBackend` 落库 → toast → 关闭；
   - 新建模式：`structuredClone` → 合并译文 → 赋新标题 → 写入 store（复用 `duplicateResume` 同款 set 路径）→ `syncResumeToBackend` → `router.push` 新工作台 → toast；
4. 失败：`toast.error` 保留对话框可重试；中断/超时同理。

视觉细节（frontend-design 准则，克制服务于已定稿的 Paper & Punch 体系）：

- Dialog 居中卡片、`rounded-xl`、`border-line`、`shadow-[var(--shadow-card)]`；
- Radio 选项用带边框卡片式选择（选中态 ink 描边 + cobalt 指示点），符合硬边几何语言；
- 中文小标签用 `.eb-zh`（禁 mono+uppercase+letter-spacing，项目铁律）。

### 4.3 `lib/resumeTranslate.ts` — 纯函数（新，可单测）

```ts
extractTranslatableFields(resume: ResumeData): Record<string, string>
applyTranslatedFields(resume: ResumeData, fields: Record<string, string>): ResumeData  // 返回新对象
TRANSLATE_LANGUAGES: { code: string; label: string }[]
```

- `applyTranslatedFields`：对缺失 key 保留原文（部分成功可用）；绝不触碰 id/配置/日期；
- `markdownContent` 若为空/缺失则不进入 fields。

### 4.4 i18n

`zh.json` / `en.json` 双写：

- `previewDock.translate.tooltip`（「翻译简历」/ "Translate Resume"）；
- 新命名空间 `translateResume.*`：title、language、mode.overwrite、mode.createNew、newTitle、confirm、translating、overwriteWarn、success、error 等。

### 4.5 API 调用

沿用现状：`fetch("/api/ai/translate", ...)` 直连（与 `useGrammarStore` / `AIPolishDialog` 同款，Vite dev 经代理、生产同源 `/api`）。

---

## 5. 测试计划

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 前端单测 | `frontend/tests/resume-translate-fields.test.ts`（新） | extract 字段清单正确；apply 合并/缺 key 回退；不触碰 globalSettings/ids/日期；markdownContent 进出一致 |
| 前端单测 | `frontend/tests/preview-dock-actions.test.ts`（追加） | Dock 含 `Languages` 图标按钮 + `TranslateDialog` 挂载 |
| 后端单测 | `tests/test_ai_translate.py`（新） | 契约（白名单语言/空 fields 拒绝）、mock LLM 成功回传、ConfigError 路径、多余 key 丢弃 |
| 回归 | 前端 vitest 全量 + 后端 pytest 全量 | 不破坏现有用例 |

## 6. 代码审查清单（交付前自查）

a. 可读性与注释：字段清单映射、合并逻辑有中文注释说明「为何不整包回传」；
b. 性能与安全：fields 总量上限防滥用；LLM 输出只当「译文字典」使用（无 eval/动态执行面）；prompt 注入面评估（用户文本进 prompt → 只影响译文本身，不产生工具调用，风险受控）；
c. 风格：遵守 AGENTS.md（API `/api` 前缀、i18n 双写、注释密度与命名对齐邻近组件）。

## 7. 交付物

1. 代码：前端组件/纯函数/i18n + 后端端点/prompt/常量 + 测试；
2. 文档：本规划文档 `docs/PLAN_resume_translate.md`（实现完成后回填「已实现」与实际行为差异）。

## 8. 执行顺序

1. 后端：`translate_fields` + prompt + 路由 + 常量 → 后端单测；
2. 前端：`resumeTranslate.ts` 纯函数 → 单测；
3. 前端：`TranslateDialog` + `PreviewDock` 入口 + i18n → dock 契约测试；
4. 全量测试 + 代码审查清单自查；
5. 手工验证（见下）并回填文档状态。

## 9. 手工验证步骤

1. `./start.sh` 启动前后端，进入某简历工作台；
2. Dock「翻译」→ 选 English + 覆盖当前简历 → 确认：预览正文变英文、排版/主题色/模板不变、「撤销」可恢复原文；
3. 再测 新建简历 → 确认：新简历为英文版并跳转、原简历不变、标题带 `· English` 后缀、刷新后两份都在「我的简历」；
4. 断网/LLM 未配置场景 → toast 报错、对话框可重试，简历内容不被破坏。

---

## 10. 决策点（已裁决）

| # | 决策点 | 裁决结果 |
| --- | --- | --- |
| 1 | 翻译范围 | ✅ 全部文本字段 + `markdownContent`（键值映射） |
| 2 | 积分 | ✅ 不扣积分，只记 LLM 用量台账 |
| 3 | 目标语言 | ✅ 仅简体中文 / English（用户裁决，2026-10-28） |
| 4 | 专名/人名 | ✅ 专名保留原文；中→英人名可拼音 |

## 11. 实现落点（与计划的差异）

| 产物 | 位置 |
| --- | --- |
| 翻译 prompt + 服务 | `app/services/ai_proxy.py`（`TRANSLATE_SYSTEM` / `translate_fields`） |
| 路由 | `app/api/ai.py`（`POST /api/ai/translate`，256KB 上限） |
| 用量常量 | `app/models/llm_usage.py`（`ENDPOINT_AI_TRANSLATE`） |
| 纯函数 | `frontend/src/lib/resumeTranslate.ts` |
| 对话框 | `frontend/src/components/preview/TranslateDialog.tsx` |
| 入口 | `frontend/src/components/preview/PreviewDock.tsx`（`data-dock-translate`，第一组「复制」之后） |
| i18n | `frontend/src/i18n/locales/{zh,en}.json`（`previewDock.translate` + `translateResume`） |
| 测试 | `tests/test_ai_translate.py`（11 例）、`frontend/tests/resume-translate-fields.test.ts`（8 例）、`preview-dock-actions.test.ts` 追加断言 |

差异记录：无结构性差异；落地方式「新建」比计划多加了路由兜底（与 `handleCopyResume` 同款 rAF 强制跳转）。
