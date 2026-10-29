# PLAN：工具栏新增「同行左右分列」按钮（:::left / :::right 快速配对）

> 状态：**已落地（2026-10-29 执行完毕，结果见文末）** ｜ 日期：2026-10-28
> 触发问题（用户原话）：
> 「简历编辑页面，文字选中左对齐或者右对齐，变成了整行左对齐或者右对齐，而不是选中的文本是左对齐或者右对齐」
>
> 方向（用户拍板）：**保留之前的逻辑**（左/中/右对齐按钮仍是块级语义，与 Word 一致），另在工具栏**新增一个按钮**，用既有 `:::left` / `:::right` 语法**快速实现行内（同一行）的左右对齐**，产物语法与手写 `:::left` 完全一致。

---

## 一、结论（TL;DR）

| # | 事项 | 决策 |
| --- | --- | --- |
| 1 | 对齐按钮（左/中/右/清除） | **零改动**，维持块级语义与既有契约（`editor-align-scope.test.ts` 原样保留） |
| 2 | 新增工具栏按钮「同行左右分列」 | 把一行快速拆成 `[左列 ｜ 右列]` 配对行，落成既有 `:::left` + `:::right` 块语法 |
| 3 | 预览 / PDF / 分页 | **零改动** —— 配对行合并管线（`md-pair-row`）已存在并有契约测试 |
| 4 | 编辑器内配对显示 | 沿用现状：上下两段（Tiptap 无双列节点的已知折中）；预览/导出为同一行左右分列 |
| 5 | 先前「部分选区改对齐语义」方案 | **作废**（对齐按钮语义不动） |

### 为什么用 `:::left` / `:::right` 既有语法（而非新结构）

- 预览侧 `alignPairRow` 规则已把相邻的 `:::left`（或 `:::center`）+ `:::right` 块合并为同一行 flex（左列贴左、右列贴右，`white-space:nowrap`），`editor-align-pair.test.ts` 10 条已钉契约；
- 编辑器序列化器（`wrapAlignSerializer`）已把带 align 的段落输出为 `:::name` 块，往返幂等已验证；
- 因此按钮只是把「手写 `:::left A ::: :::right B :::`」变成一键操作，**不引入新语法、不动三层管线**。

---

## 二、按钮交互契约

按钮位置：编辑区工具栏「对齐」组末位（`AlignSelector` 同侧语义），图标建议 `Columns2`（lucide，实施时按库内实际可用图标定），title/aria-label：「同行左右分列」（zh/en 双写）。

| # | 编辑器状态 | 按钮行为 | 产物（markdown） |
| --- | --- | --- | --- |
| 1 | **部分选区**（非空、落在单个顶层 textblock 内、未覆盖整块） | 拆为 `[前缀 ｜ 选中]`：前缀 `align=left`、选中 `align=right`；选区之后的文字顺延为下一段（继承原 attrs） | `:::left`（前缀）+ `:::right`（选中）相邻块 |
| 2 | **无选区（光标）** 在顶层 textblock 内部，且光标前后均有内容 | 在光标处拆：`[光标前 ｜ 光标后]` → 前 `align=left`、后 `align=right` | 同上 |
| 3 | **跨两个顶层 textblock 的选区** | 两段直接配对：上段 `align=left`、下段 `align=right`（内容不动） | 同上 |
| 4 | 光标/选区落在**已有配对行**的任一列 | **取消配对（toggle）**：两列合并回单段，清掉两侧 align，接缝处补一个空格 | 单段普通文本 |
| 5 | 其它状态：整块选区、跨 >2 块选区、嵌套块（列表项/引用内）、光标在行首/行尾（另一侧为空） | 按钮 **disabled**（无法构成左右两列） | — |

补充规则：

- **空白修剪**：拆分边界不把接缝空格带入列内容（前缀尾随空白、右列开头空白修剪）；
- **配对判定与预览同构**：相邻两块满足「前者 align=left/center + 后者 align=right」即视为配对行（与 `alignPairRow` 合并条件一致），按钮激活态（`active`）= 光标所在块参与任一配对行；
- **行内标记保留**：`strong/em/a` 等 marks 随 `Fragment.cut` 留在原侧；
- **单条 undo**：拆分/合并在同一事务完成；
- **对齐按钮联动**：配对生成后，可对左列点「居中」→ 变 `:::center` + `:::right`，预览仍合并同行（既有规则）；对任一列点「清除对齐」即拆掉该配对行（恢复普通段落），语义自然衔接，无需额外 UI。

### 示例（块内文本 `字节跳动 · 高级前端工程师 2021.07 – 2024.12`）

| 操作 | 编辑器内 | 预览 / PDF |
| --- | --- | --- |
| 选中日期 → 点按钮 | 两段：`字节跳动 · 高级前端工程师` / `2021.07 – 2024.12`（右对齐） | 同一行：`字节跳动 · 高级前端工程师 ······· 2021.07 – 2024.12` |
| 光标落在「工程师」与「 2021」之间 → 点按钮 | 同上 | 同上 |
| 再点一次（光标任一列） | 合并回单段 `字节跳动 · 高级前端工程师 2021.07 – 2024.12` | 单段普通文本 |

---

## 三、实施方案

### 3.1 核心改动：`frontend/src/components/editor/extensions/align.ts`

新增命令（挂在既有 `Align` 扩展，属性/序列化机制全部复用）：

- `setAlignPair()`：按上表 1–3 拆分/配对；
- `toggleAlignPair()`：处于配对行则合并，否则按状态调用 `setAlignPair`；
- 检测辅助 `findPairSibling(state)`：返回光标/选区所在块的配对兄弟（前或后）与位置。

实现拆成两个**纯函数**（node 单测友好，不依赖 DOM）：

1. `splitBlockFragments(parentNode, fromRel, toRel) → { prefix, middle, suffix }`
   —— `parentNode.content.cut()` 三切 + `parentNode.copy(fragment)` 造同类型段，边界空白修剪；
2. `planPairLayout(hasPrefix, hasSelection, hasSuffix) → Array<{ part, align }>`
   —— 配对决策表（左列 left / 右列 right / 顺延继承）。

命令层 glue 只调 `tr` 实例方法（保持现有 `state: any, tr: any` 鸭子类型风格）：

```ts
tr.replaceWith(blockPos, blockPos + node.nodeSize, newNodes)  // 1–3 段替换原块
tr.setSelection(state.selection.map(tr.doc, tr.mapping))      // 选区落到右列内容
```

### 3.2 工具栏：`frontend/src/components/editor/MarkdownEditor.tsx`

- 对齐组末位新增 `ToolbarButton`（27px 高、`onMouseDown preventDefault` 既有约定）；
- `active` / `disabled` 由 `useEditorState` selector 一并订阅（沿用 I14 精准订阅模式）；
- i18n：`markdownEditor` 命名空间 zh/en 双写（`toolbar.alignPair` 等键）。

### 3.3 依赖与测试基建（实测结论，零新增安装）

| 事实 | 依据 | 影响 |
| --- | --- | --- |
| `@tiptap/core` re-export `Fragment` / `getSchema` / `createDocument` | 实测 148 个导出 | 单测用真实 schema/doc/Fragment，无需 `prosemirror-*` 直依赖 |
| 裸 `import "prosemirror-model"` / `"@tiptap/pm"` 解析失败（pnpm 隔离） | 实测 `ERR_MODULE_NOT_FOUND` | 测试禁止直接 import prosemirror，只经 `@tiptap/core` |
| 本沙箱 `pnpm add` 被 broker 硬拒 | 既往实测 | 不新增依赖 |

### 3.4 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/components/editor/extensions/align.ts` | 新增 `splitBlockFragments` / `planPairLayout` / `setAlignPair` / `toggleAlignPair` / 配对检测 |
| `frontend/src/components/editor/MarkdownEditor.tsx` | 工具栏新增按钮（active/disabled/title） |
| `frontend/src/i18n/**`（markdownEditor 命名空间） | zh/en 文案双写 |
| `frontend/tests/editor-align-pair.test.ts` | 保留 10 条；**新增**按钮产物形态断言（拆分结果 → `:::left`+`:::right` → `md-pair-row`） |
| `frontend/tests/editor-align-selection.test.ts` | **新增**：交互契约 5 态决策表 + Fragment 三切（marks 保留、空白修剪）+ 合并回单段 |
| `frontend/tests/editor-align-scope.test.ts` | **不动**（对齐按钮语义未变，契约原样成立） |
| `frontend/scripts/editor-probe/main.js` | 新增端到端用例：选区/光标 → `toggleAlignPair` → `getMarkdown()` → `renderMarkdownToHtml`（含 toggle 往返、幂等） |
| `docs/PLAN_editor_align_selection.md` | 本文件，执行后回填「执行结果」 |
| `docs/README.md` | 索引登记 |

---

## 四、测试与验证计划

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| 单元测试 | `cd frontend && npx vitest run tests/editor-align-selection.test.ts tests/editor-align-pair.test.ts tests/editor-align-scope.test.ts` | 交互契约 5 态、Fragment 切割、配对产物、既有契约无回归 |
| 全量回归 | `cd frontend && npx vitest run` | 不新增失败（`classify-description.test.ts` 6 例历史失败与本次无关） |
| 端到端 | `cd frontend && node scripts/editor-probe/run.mjs` | 真实 Chromium：拆分/toggle/序列化/预览合并/幂等 |
| 手工抽查 | dev server（3005） | 选中日期点按钮 → 上下两段（左/右），预览同一行；再点合并回单段 |

验收标准：

1. 选中行尾日期点按钮 → `getMarkdown()` 产出 `:::left`（前缀）+ `:::right`（日期）相邻块，预览为 `md-pair-row` 同一行；
2. 产物语法与手写 `:::left ... :::right ...` **逐字节一致**（同一序列化器输出）；
3. 对齐按钮行为与改前完全一致（`editor-align-scope.test.ts` 全绿）；
4. toggle 一来一回文本内容无损（含 `**加粗**` 等行内标记）；
5. 全量 vitest 无新增失败 + probe 断言通过。

---

## 五、风险与边界

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 用户在编辑器看到「上下两段」而非同一行 | Tiptap 无双列节点的已知折中（预览/导出是同一行） | 按钮 title 说明；文档写明；真同行（双列 NodeView）列为后续独立任务 |
| 配对判定与预览合并条件必须同构 | 否则「编辑器认为是配对、预览不合并」或反之 | 判定逻辑注释锚定 `alignPairRow` 规则；配对契约测试双向覆盖 |
| 嵌套块（列表/引用内）拆分会破坏列表项结构 | 一个 list item 内多段 | 显式排除（disabled），写入测试 |
| 整块选区无自然拆点 | 无法构成两列 | disabled（按钮态可见，避免误触） |
| toggle 合并接缝 | 原文接缝可能无空格（如「工程师2021」） | 统一补一个空格，注明取舍 |

---

## 六、交付物

1. 代码：`align.ts`（新命令）+ `MarkdownEditor.tsx`（按钮）+ i18n + 2 个测试文件 + editor-probe 用例；
2. 文档：本计划（含执行结果）+ `docs/README.md` 索引；
3. 证据：单测输出、probe JSON 断言、编辑区/预览截图（可选）。

---

## 七、执行结果（2026-10-29）

### 7.1 实际改动文件

| 文件 | 改动 |
| --- | --- |
| `frontend/src/components/editor/extensions/align.ts` | 新增 `planPairLayout` / `locateTopBlock` / `applyPairSplit` / `applyPairMerge` / `fragmentEdgeIsWhitespace`，注册 `setAlignPair` / `toggleAlignPair` 命令；`getPairAction` 增加「配对行内优先 merge」规则 |
| `frontend/src/components/editor/MarkdownEditor.tsx` | 对齐组末位新增 `Columns2` 图标按钮（active=已在配对行、disabled=不可拆） |
| `frontend/src/i18n/locales/zh.json` / `en.json` | `markdownEditor.toolbar.alignPair` 双写 |
| `frontend/tests/editor-align-selection.test.ts` | **新增** 30 例：Fragment 三切、决策表、5 态判定、命令产物、与手写语法同构 |
| `frontend/tests/editor-align-pair.test.ts` | 追加「按钮产物 → md-pair-row」衔接断言（11 例） |
| `frontend/scripts/editor-probe/main.js` | 追加用例 6 / 6b / 6c（拆分、toggle 往返、跨两块配对） |
| `frontend/tests/editor-align-scope.test.ts` | **未动**（对齐按钮语义未变，契约原样成立） |

### 7.2 验证证据

| 层 | 结果 |
| --- | --- |
| 单元测试 | `editor-align-selection` 30 + `editor-align-pair` 11 + `editor-align-scope` 7 = 48 例全绿 |
| 全量回归 | 28 文件 / 227 例全绿（含此前偶发失败的 `classify-description` 6 例） |
| 端到端（真实 Chromium） | `alignPairSplit`：2 段 `[left, right]`，序列化 = `:::left`+`:::right` 块，预览含 `md-pair-row`；`alignPairToggle`：合并回 1 段、文本无损、align=null；`alignPairTwoBlocks`：两段仅落 align |
| 类型检查 | 本次改动文件 0 新增 tsc 错误（新测试文件的 harness 类型噪声已用 `as any` 清零） |

### 7.3 执行中钉死的取舍（与计划的差异点）

1. **选区贴行首取镜像布局**：计划行 1 只写了 `[前缀 | 选中]`；若前缀为空仍按字面产出「空左列 + 选中右列」，预览 `alignPairRow` 缺左列块**根本合并不出同行**。故选中贴行首时取镜像 `[选中 left | 后缀 right]`（选公司名点按钮即得「公司 | 日期」行）。
2. **纯空白选区退化为光标拆**：选中内容全为空白时修剪后 middle 为 null，按接缝拆 `[空白前 | 空白后]`，保证「按钮可点 = 命令生效」，不产生空列。
3. **合并接缝空格条件补**：不「统一补空格」，而是**接缝两侧均无空白时才补一个**，避免用户编辑后出现双空格；拆分时修剪 + 合并补一格使常见往返无损。
4. **`Fragment.from` / `Fragment.isFragment` 不可用**：`@tiptap/core` re-export 的 Fragment 类缺静态方法（类型声明与运行时不一致，实测 `undefined`）。合并接缝改用 `left.node.type.create(null, state.schema.text(" ")).content` 取真 Fragment（实例方法 `append/cut` 均正常）。

### 7.4 遗留

- 编辑器内配对行显示为上下两段（Tiptap 无双列节点的已知折中）；「编辑器内真同行」（双列 NodeView）列为后续独立任务，不在本次范围。
