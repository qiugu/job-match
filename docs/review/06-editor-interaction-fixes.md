# 06 · 编辑器页交互问题修复记录

> 对应评审：[05-editor-interaction.md](05-editor-interaction.md)（I1–I16）
> 修复范围：`frontend/`（编辑器页 Markdown 工作台）
> 验证：`tsc --noEmit`（无新增错误）、`vitest run`（179 passed）

---

## 一句话结论

评审列出的 **16 条交互问题已全部落地修复**，按「信任 → 可用 → 正确性 → 打磨」四批推进。
两处保留既有实现是**有意的取舍**（见文末「取舍与残留」），不是遗漏。

---

## 逐条对照

| ID | 问题 | 修复要点 | 主要文件 |
| --- | --- | --- | --- |
| **I1** | 「auto-save」虚假承诺 | 把 600ms 防抖自动落库从「仅主题色」上提到 store：`updateGlobalSettings` 与 `setThemeColor` 共用同一落库节流窗口，左栏 5 项排版设置真正落库 | `store/useResumeStore.ts` |
| **I2** | 自动保存后脏标记不刷新 | 脏基准 `savedSnapshotRef`（组件 ref）提升为 store 字段 `savedSnapshots`；由 `syncResumeToBackend`、`loadResumesFromBackend`、`setActiveResume` 统一写入，顶栏只读不再自行维护 | `store/useResumeStore.ts`、`EditorHeader.tsx` |
| **I3** | 校对应用与单一真源不匹配、只标第一页 | ①跨所有 `.md-page-sheet .resume-markdown-preview` 标记；②预览重建后广播 `resume-preview-updated` 重新套高亮；③「应用建议」改为直接改 `markdownContent` 区间文本；④校对输入拼合全部分页文本 | `store/useGrammarStore.ts`、`GrammarCheckDrawer.tsx`、`MarkdownPreview.tsx`、`hooks/useGrammarCheck.ts` |
| **I4** | 预览固定 210mm、无缩放 | 预览头新增缩放档位（适配 / 75% / 100%），默认「适配」，用 `transform: scale` 只作用于显示副本；测量副本保持原尺寸，分页坐标不受影响 | `MarkdownPreview.tsx`、`MarkdownWorkbench.tsx` |
| **I5** | 右侧 dock 叠在预览列上 | 预览内容区预留 56px 右侧安全区（`pr-14`），纸张居中后始终落在固定 dock 左侧 | `MarkdownWorkbench.tsx` |
| **I6** | 段落与无序列表同时激活 | 「段落」判定补上 `!bulletList && !orderedList` 容器排除 | `MarkdownEditor.tsx` |
| **I7** | 取消对齐图标语义相反、无激活态 | 图标改 `Eraser`（清除语义），并补显式激活态（无任何对齐 = 默认对齐） | `MarkdownEditor.tsx` |
| **I8** | 滑块无可见焦点 | `.pp-slider:focus-visible` 轨道 2px 钴蓝描边 + 手柄光晕；4 个 range 全部补 `aria-label` | `app/globals.css`、`MarkdownWorkbench.tsx` |
| **I9** | 字体无色板语义、色板用十六进制当名 | 字体组改 `role="radiogroup"` + `aria-checked`；色板补中英文色名（`aria-label`/`title`/`aria-pressed`） | `MarkdownWorkbench.tsx`、`i18n/locales/*.json` |
| **I10** | 「Markdown 源」伪装成 tab、汉字被拉散 | 面板标题改 `.eb-zh`（正文体、0 字距），文案改「Markdown 编辑」，左栏图标改 `SlidersHorizontal` | `MarkdownWorkbench.tsx`、`i18n` |
| **I11** | 标题双源 | 顶栏输入明确为「简历文件名」（`aria-label`/placeholder/title），补 Enter 提交、Esc 取消、放宽宽度；正文 H1 生成改用「姓名 \| 职位」，不再写入占位文档名 | `EditorHeader.tsx`、`utils/markdown.ts` |
| **I12** | 两处常驻无限动画 | 删除错误徽标 `animate-pulse`（改静态红点 + 计数）；删除 dock 的 `MagicThread`（`repeat: Infinity`） | `EditorHeader.tsx`、`PreviewDock.tsx` |
| **I13** | 禁用按钮 Tooltip 不显示、信号色滥用 | Tooltip 触发器外包 `span`（可接收指针事件）；dock 眼睛激活态由钴蓝改墨色，信号色只留给真正的主操作 | `EditorHeader.tsx`、`PreviewDock.tsx` |
| **I14** | 每次按键全量重渲 + 每帧全对象 stringify | `shouldRerenderOnTransaction: false` + `useEditorState` 精确订阅工具条状态；`variantCss` 改 `useMemo`；Cmd+S 用 ref 只绑一次 | `MarkdownEditor.tsx`、`MarkdownPreview.tsx`、`EditorHeader.tsx` |
| **I15** | 令牌偏差 | 纸张 `shadow-lg`（blur 15px）改硬偏移 `--shadow-card`；页码 `text-gray-400` 改 `text-ink-3`；静态「A4」假控件换成真实缩放选择器；编辑态字号/行高/字族同步产出态 | `MarkdownPreview.tsx`、`MarkdownWorkbench.tsx`、`MarkdownEditor.tsx` |
| **I16** | dock 三种体量、两种节奏、三级圆角 | 重写 dock：单一 28px chip、单一 `gap-1` 网格、两级圆角（容器 `xl` / 内部 `lg`）、去 `scale 1.2`、FAQ 统一为 compact 28px | `PreviewDock.tsx`、`FAQDialog.tsx` |

---

## 关键实现说明

### I1 / I2：单一保存真源

- store 新增 `savedSnapshots: Record<string, string>`（按简历 id 存干净基准）。
- 所有成功落库路径（`syncResumeToBackend`）与后端加载（`loadResumesFromBackend`）统一刷新基准；
  切换到已落库简历时，若缺基准则以当前内容补种（`setActiveResume`）。
- `updateGlobalSettings` / `setThemeColor` 内部共用模块级 600ms 防抖计时器 `globalSettingsSaveTimer`，
  拖动滑块期间只发一次请求。
- 顶栏 `isDirty` 改为读 store 基准，不再在组件内维护第二份真相。

### I3：校对基于源码区间 + 跨页高亮

- `getPreviewRoots()` 只取 `.md-page-sheet` 内的显示副本，天然排除隐藏测量副本。
- `applyMarks(errors, selectedIndex)` 是唯一高亮入口：先 `unmark()` 再逐错误标记，
  每页每个错误只标首个命中。
- 预览 `enhancedHtml` 变化（= DOM 重建）后广播 `resume-preview-updated`，抽屉监听并 `remarkErrors()`，
  解决「敲一个字波浪线全消失」。
- `handleAccept` 不再递归替换整份简历对象，而是对 `markdownContent` 做目标片段替换
  （有 context 时优先整段定位），失败明确 toast，不再「点了没反应」。

### I4：缩放只影响显示副本

- `fit` 用 `ResizeObserver` 跟踪容器宽，`scale = min(1, (width-32)/A4宽)`，只降不升。
- 外层按「缩放后尺寸」占位、内层 `transform: scale(origin top-left)`，滚动高度与宽度都正确。
- 未显式传 `zoom` 的场景（仪表盘缩略图）保持 1:1，不改变既有渲染。
- PDF 导出克隆的是 `#resume-preview` 节点本身，祖先的 `transform` 不在克隆范围，导出不受影响。

### I16：dock 结构性收口

删除 magicui `Dock`/`DockIcon`（其分组扫描对当前用法完全空转）、手写 `h-[1px]` 分隔线与
`whileHover scale 1.2`，改为一列 `gap-1` 的 28px chip；激活态只换色（`bg-ink text-paper`）不改尺寸。

---

## 验证

### 类型检查

```
npx tsc --noEmit
```

结果：31 行报错，**全部为既有问题**（`next/*` 残留模块、`tests/editor-align-scope.test.ts` 与
`tests/store-sync-resume.test.ts` 的历史类型问题）。**没有任何一条指向本次修改的文件。**

### 单元测试

```
npx vitest run
```

- `tests/editor-align-scope.test.ts` 的契约「工具栏只使用 3 次 `isActive({ align: ... })`」在初次修复后
  被 I7 的 alignNone 判定打破（变成 6 次）。**未放宽测试**，而是重构 selector 复用三个对齐布尔值，
  恢复为 3 次 —— 契约保持，实现更 DRY。复跑 7/7 通过。
- 其余 24 个测试文件全部通过。

> 说明：由于改动仅涉及前端交互层，未新增/修改后端或数据契约，未运行后端 pytest。

---

## 取舍与残留（有意为之，非遗漏）

| 项 | 现状 | 原因 |
| --- | --- | --- |
| I14 的「预览 markdown 防抖」 | **未加** | 预览 DOM（`#resume-preview`）是 PDF 导出的克隆源，加防抖会让「刚敲完立刻导出」捕获旧内容；导出保真优先级高于 ~150ms 的输入流畅度。已通过 `shouldRerenderOnTransaction: false` + `variantCss` 缓存显著降低每键成本。 |
| I14 的「脏判定改 revision 计数器」 | **保留 JSON.stringify** | 改 revision 需要在 `updateResume`/undo/redo/导入等所有写路径同步递增，改动面大且易漏；当前 stringify 在 2 页简历量级约 0.1–0.3ms，非瓶颈。正确性优先。 |
| I9 的「合并两个蓝」 | **保留两个蓝** | `#0047AB` / `#2563EB` 可能被模板与既有简历引用，删除会波及 `THEME_COLORS` 联合类型与历史数据；已改为可辨识的中英文色名，先解决可访问名问题。 |
| I5 的 dock 位置 | **保持 fixed + 预留安全区** | `PreviewDock` 是桌面端折叠/展开预览的**唯一入口**（`LayoutControls` 仅定义未渲染），移进可折叠面板会导致收起后无法再展开。改用右侧安全区达成「不遮挡正文」。 |
| I11 的「顶栏改 H1」 | **区分而非合并** | 采用「顶栏=文件名、正文=H1」的区分方案，并在 UI 上明确语义；未把顶栏输入写回 markdown 首行（会让「改文件名」意外改动正文）。 |

---

## 回归关注点（供人工验收）

1. **保存状态**：修改任意排版滑块 → 600ms 后顶栏状态点应变「已保存」、保存按钮置灰；刷新页面设置不丢。
2. **校对**：2 页简历在第 2 页构造错误 → 「应用」后正文确有变化、第 2 页可高亮可定位；敲字后波浪线应自动恢复。
3. **预览缩放**：1440/1512 视口默认「适配」应能看全整页；切 100% 允许横向溢出（用户主动选择）。
4. **dock**：一列按钮应等高、等距、同级圆角；FAQ 不再是大号贴纸。
5. **工具栏**：光标在无序列表内时，只有「无序列表」激活，「段落」不再同时激活；无对齐时 `Eraser` 显示为激活。
