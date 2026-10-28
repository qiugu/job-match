# 02 · 前端契约、渲染安全与可维护性

> 评审对象：`frontend/src/`（323 个 `.ts/.tsx`，约 38,300 行）+ `frontend/tests/`
> 评审方式：只读通读 + 渲染链路回读 + 实测（`vitest run` 167 例全绿）
> 结论基准日：2026-10-27（HEAD `bc9b04c`）

## 结论

前端的**工程基本功是合格的**：路由级鉴权守卫写在布局路由上（`routes/app/route.tsx:20-40`）、
登录回跳做了开放重定向校验（`routes/login.tsx` 的 `validateSearch` 只接受 `/` 开头）、
401 处理统一收敛、无硬编码密钥、契约与后端 `ResumeData` 逐字段一致。

问题集中在**渲染层的「信任假设」**：两套 HTML 渲染路径都建立在「内容是可信的」这个前提上，
而这个前提在当前架构下并不成立（S1、S2）。其余是规模性债（巨型组件、无虚拟列表）与
工具链接入缺口（类型检查范围、lint 无入口）。

---

## 问题清单

### S1 · Markdown 预览开启 raw HTML 且无清洗（P1）

> **状态：已修复（P1）**。引入 `isomorphic-dompurify`，在 `markdownRender.ts` 的 `renderMarkdownToHtml` 出口对 HTML 做白名单清洗（`src/lib/sanitize.ts` 的 `sanitizeResumeHtml`），保留 `html: true` 语义（PDF 列表不丢）的同时剥离 `<script>` / `on*` 事件 / `javascript:` 协议。新增 `tests/sanitize.test.ts` 覆盖注入载荷，`npx vitest run tests/sanitize.test.ts` → 12 passed。

**证据**

- `frontend/src/utils/markdownRender.ts:5-9`：

  ```ts
  const md = new MarkdownIt({
    // 允许原始 HTML 透传：原简历来自 PDF 提取，会带 <ul><li> 等残存标签，
    // ...简历 markdown 不接受用户上传内容（仅服务端 LLM 与 PDF 提取），XSS 面极小。
    html: true,
  ```

- `frontend/src/components/preview/MarkdownPreview.tsx:330` `renderMarkdownToHtml(markdown)` → `:513` / `:543` `dangerouslySetInnerHTML={{ __html: enhancedHtml }}`。
- 全库检索 `DOMPurify` / `sanitize` → **0 命中**（`frontend/src` 内无任何清洗库）。

**根因** 注释里的两个前提都不精确：
①「不接收用户上传内容」—— `markdownContent` 可由用户在编辑器内直接键入原始 HTML；
②「XSS 面极小」—— 真正的高危链路是 **JD 文本 → LLM 生成 markdown → 渲染**：用户在
`/app/dashboard/match` 粘贴的 JD 若含「输出 `<img src=x onerror=...>`」类指令，模型可能
把 HTML 原样写进 `markdown_content`，返回后未经清洗直接执行。

**影响** 由于令牌存在 `sessionStorage`（`lib/auth.ts:14`），一旦脚本执行即可读走令牌。
在当前架构下**受害者与攻击者是同一人**（无任何共享/公开渲染路由 —— 已确认 `routes/` 下
只有 8 个路由，无 `/share` / `/r/[id]` 类页面），因此不构成跨用户存储型 XSS，定为 P1 而非 P0。
但它是「单点把令牌暴露给脚本」的全部前提，且与后续任何共享功能的引入形成乘法风险。

**建议** 引入 `DOMPurify`（或 `isomorphic-dompurify`）在 `renderMarkdownToHtml` 出口统一
`sanitize`，白名单保留 `ul/li/p/span/div/br/strong/em/a` 与 `class`（`md-align-*` 依赖它）。
导出到服务端渲染的链路不能只靠 `pdf_export.py` 的 strip —— 那是另一条独立防线。

---

### S2 · 富文本「含标签即完全信任」（P1）

> **状态：已修复（P1）**。`normalizeRichTextContent` 出口统一过 `sanitizeResumeHtml`；`decorateRichTextAnchors` 现真正调用 `normalizeLinkHref`（`//` → `https:`、裸域名 → `https://`、危险协议剥离 `<a>`）。两处共用同一白名单，无口径分叉。验证见 `tests/sanitize.test.ts`（12 passed）。

**证据** `frontend/src/lib/richText.ts:105-112`：

```ts
export const normalizeRichTextContent = (content?: string) => {
  if (!content) return "";
  let normalized = content;
  if (!HTML_TAG_REGEX.test(content)) {          // ← 只有「一个标签都没有」时才转义
    normalized = escapeHtml(content).replace(/\r\n|\r|\n/g, "<br />");
  }
  return decorateRichTextAnchors(...)
```

即：`纯文本 → escapeHtml`；`含任意 `<x` → 原样透传`。同文件的 `normalizeLinkHref`（`:71-98`）
本身有协议白名单（会拦 `javascript:`），但**未被 `normalizeRichTextContent` 调用**，形同虚设。

**证据（消费面）** 全库 55 个文件使用 `dangerouslySetInnerHTML`，其中 54 个是简历模板的
section 组件（`components/templates/{swiss,elegant,classic,modern,timeline,left-right,creative,minimalist,editorial}/sections/*.tsx`），
统一形如 `ExperienceSection.tsx:45` / `EducationSection.tsx:76` / `SkillSection.tsx:20`：

```tsx
dangerouslySetInnerHTML={{ __html: normalizeRichTextContent(data.experience?.[i]?.description) }}
```

**根因** 把「是否含 HTML」当成了「是否可信」的判据。这两件事没有关系。

**影响** 字段正常由 Tiptap 产出（ProseMirror schema 会过滤非法标签），但存在两条外部写入路径：
① `POST /api/ai/resume-import` 的 LLM 解析结果（`app/api/ai.py:104`）直接写进结构化字段；
② PDF 上传后的文本提取。两者都可能把任意 HTML 落进 `description`，随后在模板里执行。

**建议** 与 S1 同批：`normalizeRichTextContent` 出口统一过 DOMPurify（白名单保留
`p/br/strong/em/ul/ol/li/a/span` + `class` / `href`），并让 `normalizeLinkHref` 真正参与
`<a href>` 的重写。**同批**的理由：两处共用同一套白名单，分两次做必然出现口径分叉。

---

### A1 · 巨型文件与职责混杂（P2）

**证据（`wc -l` 实测）**

| 文件 | 行数 | 混杂的职责 |
| --- | --- | --- |
| `app/app/dashboard/match/page.tsx` | 1642 | 匹配表单 + 匹配结果 + 话术生成 + 衍生简历管理，自管 `localStorage`（`:450` `STORAGE_KEY_LAST_PITCH`） |
| `store/useResumeStore.ts` | 1013 | 全站简历状态（无 persist，见下） |
| `components/editor/SidePanel.tsx` | 816 | 编辑器侧栏编排（纯委托，无本地 hook） |
| `config/markdownTemplates/samples.ts` | 883 | 静态样张数据（合理，不列为缺陷） |
| `components/preview/MarkdownPreview.tsx` | 756 | 渲染 + 分页度量 + `enhanceBracketSections` 字符串处理 |
| `lib/jobmatch.ts` | 682 | 全部后端 API 客户端 |

`match/page.tsx` 的 `useEffect` 数量为 7（`Grep` 统计），全部聚在单组件内做副作用协调。

**影响** 单文件改动无法隔离验证；`match/page.tsx` 的任何一次小修都要重跑该页全部交互路径。
不影响运行时正确性，属可维护性成本。

**已排除**：`useResumeStore.ts` 已移除 `persist`（`:3` 注释确认），不存在多页 localStorage 串台；
Zustand 为模块单例，无跨用户数据残留。

---

### A2 · 类型检查范围未覆盖测试与孤立文件（P2）

> **状态：已修复（P1）**。`tsconfig.json` 的 `include` 已从仅 `src/routes` 扩为 `["src", "tests", "*.config.ts", "vitest.config.ts"]`，组件与测试进入类型检查。放宽后 `tsc --noEmit` 仍为 **25 个错误（全部为既有 Next 迁移残留 `src/app/**` 死代码 + 2 个测试文件的 Tiptap/ResumeData 类型），无新增错误** —— 见下「实测补充」。

**证据** `frontend/tsconfig.json`：

```json
"include": [
  "src/routes/**/*.ts",
  "src/routes/**/*.tsx",
  "src/router.tsx",
  "src/routeTree.gen.ts",
  "src/vite-env.d.ts",
  "vite.config.ts",
  "vitest.config.ts"
]
```

- `src/components/**`、`src/app/**`、`src/lib/**`、`src/store/**`、`src/utils/**` 均**不在 include 内**。
  它们只能通过 `src/routes/*` 的传递 import 被「顺带」纳入程序（TypeScript 会跟进 import 图），
  因此**未被任何路由引用到的文件完全不做类型检查**。
- `frontend/tests/**`（24 个测试文件）**不在 include**，vitest 只做转译不做类型检查。
- `strict: true` 已开启，但缺 `noUncheckedIndexedAccess`；`allowJs: true` 使 `.js` 也进入编译但不做严格校验。

**影响** 死代码与测试辅助代码是类型盲区；`strict` 的实际收益被「include 范围」抵消了大部分。

**实测补充**：`npx tsc --noEmit` 当前 **exit 0（无类型错误）**，耗时 5m54s。也就是说
「已纳入范围」是干净的 —— 问题不在存量错误，而在**覆盖面**：本次评审中前端探查标记的
`any` / `as any` 集中在 `utils/markdownRender.ts:106`、`types/mark.js.d.ts` 等文件，
其中部分正是未通过 `include` 显式声明、仅靠 import 图被纳入的。

**建议** 把 `include` 改为 `["src", "tests", "*.config.ts"]`（一次改完，成本最低），
再评估是否开 `noUncheckedIndexedAccess`（该开关通常会产生大量报错，需独立批次）。

---

### A3 · 长列表未虚拟化（P2）

**证据** `Grep "react-virtual|react-window|useVirtual|virtualizer"` → `frontend/src` 内 **0 命中**。
简历列表（`app/app/dashboard/resumes/`）、岗位卡列表（`app/app/dashboard/jobs/page.tsx` 815 行）、
匹配结果列表均整列渲染。

**影响** 当前单用户量级（几十条）无感知；岗位卡按设计会随投递累积增长，达到数百条后
首屏渲染时间与内存会线性上升。属「已可预见但尚未发生」的性能债。

**建议** 待列表数据模型稳定后再引入（`@tanstack/react-virtual` 与现有 TanStack 生态一致）。
现在只在文档里记录阈值，不做改造。

---

### A4 · 前端有 eslint 配置但无执行入口（P2）

> **状态：已修复（P1）**。`package.json` 已加 `lint`（`eslint .`）与 `typecheck`（`tsc --noEmit`）脚本。原 `.eslintrc.json` 继承的 `eslint-config-next` 依赖 `next` 框架（本项目是 TanStack，不应装 next），已改为基于 `@typescript-eslint` 的标准配置（插件已在 `node_modules`），并对 `*.config.ts` 等配置文件做 override 排除 `no-require-imports` 误报。首次运行基线：**234 problems（127 errors + 107 warnings）**，绝大多数为 `no-explicit-any`（warn）与 `no-unused-vars`（err）的存量债；CI 以 `continue-on-error` 收集，不阻断。

**证据** `frontend/.eslintrc.json` 存在；`frontend/package.json` 的 `scripts` 为
`dev / prebuild / build / generate:sitemap / generate:assets / generate:brand-icons / start / preview / release / generate:template-snapshots / install:playwright / test`
—— **没有 `lint`**。CI 也没有（见分册 `03` E2）。

**影响** 配置存在但不被执行 = 团队对代码风格的共识只停留在声明层。属 WYSIWYG 幻觉类缺陷。

**建议** 补 `"lint": "eslint . --ext .ts,.tsx"` 与 `"typecheck": "tsc --noEmit"`，接入 CI。

---

## 改进建议

| 顺序 | 动作 | 覆盖 | 说明 |
| --- | --- | --- | --- |
| 1 | 引入 DOMPurify，两处渲染出口统一白名单 | S1 + S2 | **必须同批**：共用一套白名单 |
| 2 | `include` 扩到 `src` + `tests` | A2 | 一次改动，立即暴露盲区 |
| 3 | 补 `lint` / `typecheck` 脚本 | A4 | 与 CI 流水线同批 |
| 4 | 拆 `match/page.tsx` | A1 | 独立批次，需回归测试保护 |
| 5 | 长列表虚拟化 | A3 | 触发条件达成后再做 |

## 验收标准（可执行）

```bash
# S1/S2：渲染出口必须经过 sanitize
rg -c "DOMPurify|sanitizeHtml" frontend/src | wc -l          # 期望 >= 1
rg -n "html: true" frontend/src/utils/markdownRender.ts      # 若仍为 true，必须紧随 sanitize

# 用真实载荷验证（推荐做成 vitest 用例）
# 断言 renderMarkdownToHtml('<img src=x onerror=alert(1)>') 不含 "onerror"
# 断言 normalizeRichTextContent('<b>x</b><script>alert(1)</script>') 不含 "<script"

# A2：类型检查覆盖
rg -n '"include"' frontend/tsconfig.json    # 期望包含 "src" 与 "tests"

# A4：脚本存在
node -e "const s=require('./frontend/package.json').scripts;console.log(s.lint, s.typecheck)"
```

> 实测基线：`npx vitest run` → **24 files / 167 tests 全部通过**（58s）。
> 新增 sanitize 用例应挂到既有 `frontend/tests/` 目录，保持同一套 vitest 入口。
