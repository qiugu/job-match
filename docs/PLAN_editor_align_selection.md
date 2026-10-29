# 计划：选中文字对齐改为「包裹选区」语义

> 状态：**已落地（2026-10-29 执行完毕，结果见第八节）** ｜ 日期：2026-10-29
> 前置：`FIX_editor_align_scope.md`（块级对齐论证）、本文件上一版（「同行左右分列」配对方案）
> 结论：**推翻上一版的配对方案**，改为最小语义 —— 对齐按钮把「选中文字」包裹成独立对齐块。

---

## 一、决策反转的经过

| 阶段 | 方案 | 问题 |
| --- | --- | --- |
| 2026-09-11 | 「对齐 = 块级」不变，只修工具栏高亮缺陷 | 用户再次反馈「选中文字没对齐」 |
| 2026-10-28 | 新增「同行左右分列」按钮，产出 `:::left` + `:::right` 配对 | 预览真同行（`.md-pair-row`），**编辑器内仍是上下两段** |
| **2026-10-29** | **对齐按钮本身改为「包裹选区」** | 接受「编辑器与预览一致（都是两行）」，放弃按钮产出的同行版式 |

反转动因（用户原话：「这么做太丑了」）：配对方案造成**编辑器两行 / 预览一行**的所见即所得断裂。包裹方案让两边一致 —— 这才是「丑」的真正来源，不是配色或间距。

关键澄清（已核实）：**单套 `:::right` 并不会让编辑器变好看**。编辑器里 `:::left` / `:::right` 都只是「段落 + align 属性」，`div` 容器在解析期即被丢弃（`align.ts` 的 `updateDOM`）。两种做法在编辑器里都是两行，差别只在预览。

## 二、最终语义规格

**对齐按钮（居左 / 居中 / 居右）在「单块内部分选区」时，把选中文字包裹成独立对齐块。**

| 输入 | 行为 | 产物 markdown |
| --- | --- | --- |
| 单块内部分选区（前后有内容） | 拆 3 段：前缀 / **选中（目标对齐）** / 后缀 | `前缀` + `:::right\n选中\n:::` + `后缀` |
| 选中贴行首 | 拆 2 段：**选中（目标对齐）** / 后缀 | `:::right\n选中\n:::` + `后缀` |
| 选中贴行尾 | 拆 2 段：前缀 / **选中（目标对齐）** | `前缀` + `:::right\n选中\n:::` |
| 选中覆盖整块 | **老行为**：整块设置对齐 | `:::right\n整块\n:::` |
| 跨多块选区 | **老行为**：相交块全部设置 | 各块 `:::align` |
| 光标（无选区） | **老行为**：作用于光标所在块 | 单块 `:::align` |
| 嵌套块（列表项 / 引用内） | **老行为**：不拆分（避免破坏列表结构） | 单块 `:::align` |
| 目标对齐 == 当前对齐 | **no-op**（返回 false，不产生新块） | 不变 |

> `unsetAlign`（取消对齐）同样走本规格：部分选区 → 只把选中段的对齐清空，前后片段按第五节规则处理。

## 三、为什么改动很小（零新管线）

两个既有设施直接复用，不需要新增渲染或序列化代码：

1. **序列化**：`wrapAlignSerializer`（`align.ts:135`）会把**任何**带 `align` 属性的 `paragraph` / `heading` 输出成 `:::align\n…\n:::` 块。因此「拆块 + 给中间段写 align」在 markdown 层**自动**得到 `:::right` 独立块。
2. **解析**：`alignContainerPlugin`（`markdownRender.ts:105`）把 `:::right` 解析为 `<div class="md-align-right">`，`updateDOM` 再拍平成 `align` 属性 —— 往返闭合。
3. **预览**：孤立 `:::right` 走 `markdownRender.ts:286` 的「单块 div」分支 → 独立右对齐行，**不触发** `alignPairRow` 合并（合并要求前一块为 `left`/`center`）。与编辑器两行表现一致。

上一版新增的配对机制（`planPairLayout` / `applyPairSplit` / `applyPairMerge` / `getPairAction` / `findPairSibling` / `isPairRow` / `setAlignPair` / `toggleAlignPair`）**全部删除**：按钮取消后即为死代码。

**保留不动**：`splitBlockFragments`（三切，复用）、`splitInlineAlignPair`（解析**存量**紧凑配对文档；删了会丢失 `modern` / `left-right` 模板的结构，不能动）、`wrapAlignSerializer`、`alignContainerPlugin` 接线。

## 四、代码改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/components/editor/extensions/align.ts` | 新增 `wrapSelection`（单块部分选区 → 拆块，只有中间段写目标 align）；`setAlign` / `unsetAlign` 先试包裹、不适用时回落老 `applyToBlocks`；删除配对命令与配套纯函数；删除两条 `Commands` 类型声明 |
| `frontend/src/components/editor/MarkdownEditor.tsx` | 删除 `Columns2` 按钮、`alignPair` / `alignPairDisabled` 状态、`getPairAction` 引用与图标 import |
| `frontend/src/i18n/locales/zh.json` / `en.json` | 删除 `markdownEditor.toolbar.alignPair` |
| `frontend/tests/editor-align-scope.test.ts` | 改写第 1 条契约（「部分选区 → 整块」→「部分选区 → 只包裹选中」）+ 更新文件头论证；其余 6 条原样保留 |
| `frontend/tests/editor-align-selection.test.ts` | **重写**为包裹语义（决策表循环、三切、命令产物、markdown 往返、嵌套块回落） |
| `frontend/tests/editor-align-pair.test.ts` | 保留预览配对**渲染**契约（`md-pair-row`，手写语法仍支持）；删除上一版追加的「拆分产物 → md-pair-row」源码断言 |
| `frontend/scripts/editor-probe/main.js` | 用例 6/6b/6c 改为包裹语义端到端（真实 Chromium） |
| `docs/README.md`、`FIX_editor_align_scope.md` | 索引与交叉引用更新（后者顶部注明「部分选区语义已于 2026-10-29 变更」） |

## 五、边界契约（**需确认**）

「前 / 后缀片段继承哪一档对齐」有三种取舍。差异仅在**原块已有显式对齐**时可见（原块无对齐时三者等价）：

| 选项 | 行为 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A 继承（推荐）** | 前后缀沿用原块的 align；若继承值为 `left` 则降为 `null` | 最贴合「前后文字原样」；`left` 降级视觉无差异且**杜绝意外配对** | 原块为 `center` 时，前缀居中 + 中间右列会被**预览既有配对规则**合并为同一行（编辑器仍两行） |
| B 一律清空 | 前后缀统一降为 `null` | 永不出意外配对 | 原块居中时前缀丢失居中 —— 违反「前后文字原样」 |
| C 完全继承 | 原值照搬（含 `left`） | 最直接 | `left` + `right` 会触发预览配对，**常见**场景即出现「编辑器两行 / 预览一行」 |

推荐 **A**：唯一残留的不一致只落在「原块为居中 / 居右」这条低频路径上，且属既有渲染规则的延续。

## 六、验证计划

1. **单元测试**：`vitest run tests/editor-align-selection.test.ts tests/editor-align-pair.test.ts tests/editor-align-scope.test.ts` 全绿；再跑全量（基线：28 文件 / 227 例）。
2. **端到端**：`node scripts/editor-probe/run.mjs`（真实 Chromium）—— 部分选区 → 序列化得到**单个** `:::right` 块 → 预览渲染为独立右对齐块；反向解析回编辑器结构不变。
3. **类型检查**：`tsc --noEmit -p frontend`，本次改动文件零新增错误（仓库既有约 25 例历史错误不计）。

## 七、交付物

1. 代码：`align.ts`、`MarkdownEditor.tsx`、i18n、3 个测试文件、editor-probe 用例；
2. 文档：本文件（含执行结果回填）、`docs/README.md` 索引、`FIX_editor_align_scope.md` 交叉引用；
3. 证据：单测输出、probe 断言输出、tsc 结果。

---

## 八、执行结果（2026-10-29）

### 8.1 落地内容

| 文件 | 结果 |
| --- | --- |
| `align.ts` | 685 → 521 行。新增 `normalizeWrapAlign` / `wrapSelection` / `runAlign`；删除配对机制 11 个符号（2 条命令 + 9 个纯函数） |
| `MarkdownEditor.tsx` | 删除 `Columns2` 按钮、`alignPair` / `alignPairDisabled` 状态、`getPairAction` 引用 |
| i18n `zh.json` / `en.json` | 删除 `markdownEditor.toolbar.alignPair` |
| `editor-align-selection.test.ts` | 重写为 **23 例**包裹语义契约（三切、命令产物、no-op、回落、渲染一致性） |
| `editor-align-scope.test.ts` | 第 1 条改为「整块选区 → 不拆块」，其余 6 条原样保留 |
| `editor-align-pair.test.ts` | 预览渲染契约原样保留（手写 `:::left`+`:::right` 的同行能力不受影响） |
| `editor-probe/main.js` | 用例 3 / 6 / 6b / 6c 改写，新增 6d（居中继承边界） |

### 8.2 验证证据

- **单元测试**：3 个对齐文件 41 例全绿；全量 **29 文件 / 229 例全绿**。
- **端到端（真实 Chromium）**：
  - 行内部分选区 → 3 段，`各段align = [null,"right",null]`；
  - 行尾选区 → `前缀` + `:::right` 块，预览命中 `md-align-right`、**未命中** `md-pair-row`（编辑器两行 = 预览两行）；
  - 再次点同名对齐 → 命令返回 `false`，段数不变、序列化稳定；
  - 跨两段选区 → 两段各自 `right`，预览仍不合并。
- **类型检查**：`tsc --noEmit -p frontend` 由 26 例降到 16 例（清理了测试 harness 的类型噪声），改动文件 **0 错误**。

### 8.3 实测确认的取舍

1. **居中块 + 右对齐**：前缀保持 `center`，与右列构成「非 right + right」，预览侧既有配对规则会把它合并为同一行 —— 即第五节边界规则 A 的已知残留（probe 用例 6d 显式记录 `true`）。
2. **接缝空白被修剪**：拆分时边界空格被裁掉，形成两块后无视觉影响；若日后恢复「合并」能力需补一格。
3. **`left` 归一为 `null`**：点「居左」不再产出 `:::left` 容器（渲染等价），从而杜绝 `left + right` 相邻触发预览配对。
