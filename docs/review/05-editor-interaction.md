# 05 · 编辑器页（Markdown 工作台）交互评审

> 仓库：`job-matcher` / `frontend`
> 评审对象：`/app/workbench/$id` 编辑器页（截图为 2 页简历的编辑态）
> 评审基线：截图 2551×1433（DPR 1，Display P3）；源码 HEAD 工作区
> 评审方式：**先按截图逐区还原界面结构 → 再逐条对照组件源码取证**（每条结论均附 `文件:行`）
> 业务代码改动：**零**（本报告只诊断，不含修改）

---

## 一句话结论

**没有 P0，但有 1 个「可信度」问题必须优先修**：页面同时承诺「auto-save」并要求「保存简历」，而真实行为是**只有主题色自动保存、其余排版设置全部只在内存里**，且自动保存后脏标记不刷新 —— 三处信号互相矛盾，用户无法判断"到底存没存"。

其余 7 个 P1 里有 5 个属于同一类故障模式：**同一个状态在界面上的多处投影没有单一真源**（块类型有两个按钮同时高亮、面板可见性借用了主操作信号色、对齐按钮的图标语义与实际动作相反）。

---

## 评审范围与方法

| 层 | 覆盖 | 手段 |
| --- | --- | --- |
| 界面结构 | 顶栏 / 左（排版设置）/ 中（编辑）/ 右（预览）/ 右侧浮动 dock | 截图裁切放大逐区识读（PIL 精确裁切 + ICC 转 sRGB 采样） |
| 交互链路 | 写→预览、调排版→保存、校对→应用、导出、切模板 | 组件源码回读 + 状态流追踪（store → render → 副作用） |
| 设计系统 | Paper & Punch 令牌、双密度、CJK 小标签规则 | 对照 `docs/DESIGN.md` 与本仓 `globals.css` 令牌 |
| 无障碍 | 焦点可见性、可访问名、控件角色 | 读 CSS 与 JSX 属性（未跑 axe） |

**方法论要点**：截图口径先校准。纸张实测宽 ≈ 808px ≈ 210mm（96dpi → 793.7px），据此确认截图为 **DPR 1、视口 2551px**；再用三栏分割位置反推 `20% / 32% / 48%` 与 `LAYOUT_CONFIG.DEFAULT` 一致，避免把"缩放"误判为"布局错误"。颜色亦经 P3 → sRGB 转换后比对令牌（`#FBF5E9 ≈ --paper #FBF6EA`、`#F3ECDC ≈ --paper-2`、`#FFF` 纸张），确认截图未偏色后再对色彩下结论。

---

## 问题总表

| ID | severity | 标题 | 位置 |
| --- | --- | --- | --- |
| **I1** | P1 | 「auto-save」是虚假承诺：4 个滑块 + 字体只改内存，不落库 | 左栏 / store |
| **I2** | P1 | 自动保存后脏标记不刷新 → 顶栏长期「未保存」、保存按钮反复可点 | 顶栏 |
| **I3** | P1 | 语法检查「应用建议」与 Markdown 单一真源不匹配；错误只标第一页 | 校对 / 预览 |
| **I4** | P1 | 预览纸张固定 210mm，无缩放/无适配宽度 → 常规笔电横向溢出 | 预览 |
| **I5** | P1 | 右侧浮动 dock 叠在预览列上，遮挡文档 | 预览 |
| **I6** | P1 | 「段落」与「无序列表」两个按钮同时黑实底激活 | 工具栏 |
| **I7** | P1 | 「取消对齐」用「两端对齐」图标，且是组内唯一无激活态的按钮 | 工具栏 |
| **I8** | P2 | 滑块 `outline: none` 且无 `:focus-visible` → 键盘用户看不见焦点（WCAG 2.4.7） | 左栏 |
| **I9** | P2 | 字体选择无 `aria-pressed`；色板 `aria-label` 是十六进制值，两个蓝几乎同色 | 左栏 |
| **I10** | P2 | 面板标题「Markdown 源」被渲染成 eyebrow → 伪装成分段 tab，且汉字被字距拉散 | 编辑 |
| **I11** | P2 | 标题双源：顶栏标题输入 ≠ 正文 H1；H1 里带着占位文档名 | 顶栏 / 预览 |
| **I12** | P2 | 两处常驻无限动画（错误徽标 pulse、dock 虚线脉冲） | 全局 |
| **I13** | P2 | 主保存按钮 disabled + Tooltip `asChild` → 提示不显示；与 dock 眼睛共占信号色 | 顶栏 |
| **I14** | P2 | 每次按键全量重渲染 + 每帧全对象 `JSON.stringify`；Cmd+S 每帧重绑 | 编辑 / 顶栏 |
| **I15** | P2 | 令牌偏差：纸张用 15px 柔光阴影、页码硬编码灰、「A4」静态标签伪装成控件 | 预览 |
| **I16** | P2 | 右侧 dock：同一竖列并存 3 种体量、2 种节奏、3 级圆角，且 hover 双层叠色 | 右侧 dock |

**分布**：P0 = 0，P1 = 7，P2 = 9，合计 16。

---

## P1 详情

### I1 「auto-save」是虚假承诺

**现象**：左栏标题右上是 `auto-save`，顶栏右侧却是「保存简历」按钮 + 「未保存」状态点。

**证据**
- `MarkdownWorkbench.tsx:110-112` 写死 `t("typeset.autoSave")`，中文文案即 `auto-save`（`zh.json` → `markdownEditor.typeset.autoSave`）。
- `useResumeStore.ts:851-861` `updateGlobalSettings` 只做 `updateResume(...)`，**无任何持久化调用**。字号 / 行高 / 页边距 / 模块间距 / 字体五项全部走这条路径。
- 全页唯一自动落库的是主题色：`MarkdownWorkbench.tsx:60-71` 的 600ms 防抖 `saveActiveResumeToBackend()`。

**影响**：用户调完排版直接刷新或切简历 → 五项设置静默丢失（主题色活着）。同一面板里两种持久化语义并存，用户无法建立正确心智模型。这是本页最贵的问题：**它破坏的是对"我的改动还在不在"的基本信任**。

**修复方向**（择一，不要都做）
1. **做真自动保存**：把 600ms 防抖从主题色上提到 `updateGlobalSettings` 层（drop 到 store 中间件最稳），面板标题才配得上 `auto-save`；
2. **去掉承诺**：把 `auto-save` 改为「需保存」，并给左栏任何改动加"未保存"内联提示（如标题右上的小圆点），让用户明确知道要按顶栏保存。

> 推荐 1。理由：编辑器里已有 Markdown 单一真源 + 本地 store，自动保存的失败面很小；而"手动保存"在一个纯文本编辑场景里是纯粹的认知负担。做 1 之后顶栏的「保存简历」应当降级为次要操作（见 I13）。

---

### I2 自动保存后脏标记不刷新

**现象**：主题色改完 600ms 后已落库，顶栏仍显示「未保存」，保存按钮仍可点；再点一次会再弹一次"保存成功"。

**证据**：脏判定基准 `savedSnapshotRef` 只在 `handleSaveMatch` 内刷新（`EditorHeader.tsx:116-120`）。自动保存路径（`MarkdownWorkbench.tsx:66-70`）拿到 Promise 后只 `catch` 打日志，**不通知顶栏刷新基准**。`isDirty` 定义见 `EditorHeader.tsx:108-110`。

**影响**：状态点从"可信指示"退化为"噪声"。用户学会忽略它之后，真正的未保存也会被忽略 —— 这正是 I1 一起要修的原因：两个谎言叠在一起，等于没有状态指示。

**修复方向**：把「脏基准」从组件内 ref 提升为 store 字段（`savedSnapshot`），由**所有**成功落库的路径统一更新。顺带解掉 `savedSnapshotRef` 在换简历后首帧仍比较旧快照的窗口（`EditorHeader.tsx:105-107` 的清空发生在 effect 里，晚于同一帧的 render）。

---

### I3 语法检查「应用建议」与 Markdown 单一真源不匹配

**证据链**
- 检查输入取自渲染后的 DOM：`GrammarCheckDrawer.tsx:53-54` → `document.getElementById("resume-preview")?.innerText || markdownContent`。
- 「应用」却是对**整个 resume 对象递归做字符串替换**：同文件 `handleAccept` → `traverseAndReplace(newResume)`，命中条件 `obj[key].includes(error.context)`，兜底 `error.text.length > 2` 时全局 `replace`。
- 高亮目标只有一个节点：`useGrammarStore.ts:139-141` `new Mark(document.getElementById("resume-preview"))`。
- 而 `MarkdownPreview.tsx:531` 只给**第一页**的显示副本挂 `id="resume-preview"`（`id={isFirst ? "resume-preview" : undefined}`，注释见 `:169-172`）。

**影响**
1. `innerText` 已丢失 Markdown 标记与换行，`context` 是"渲染后的连续文本"，而替换目标是"原始 markdown 字符串" → **匹配率不确定**，失败时 `toast.error` 与"点了没反应"难以区分；
2. 兜底分支 `text.length > 2` 的全局替换会误改同名短词（如"熟悉""负责"），且无二次确认；
3. **第 2 页及之后的错误永远不会被高亮**，`selectError` 的滚动定位也只在第一页的 `mark` 里找 → 2 页简历（正是截图状态）后半段校对等于"看不见"；
4. Mark 的高亮是 DOM 注入，而预览在每次 markdown 变化时 `dangerouslySetInnerHTML` 重建（`MarkdownPreview.tsx:543`）→ **敲一个字符，全部波浪线消失**，而抽屉里的错误列表还在。

**修复方向**：校对应改为**基于 Markdown 源码定位**（返回 `{blockIndex, offset, text}`），应用时对 `markdownContent` 做区间替换；高亮改为在渲染管线里按区间插入标记（或按页维护 mark 根节点列表，遍历所有 `.md-page-sheet`）。

---

### I4 预览纸张固定宽度，无缩放能力

**证据**：`MarkdownPreview.tsx:515` `<div className="mx-auto w-[210mm]">`；根容器仅 `overflow-y-auto`（`:484-487`）。全仓 `*.tsx` 检索 `zoom|ZoomIn|缩放` 在编辑器页**零命中**（唯一 `scale-[58%]` 在未使用的旧 `preview/index.tsx:177`）。

**量化**：210mm = 793.7px；预览列 = 48% × 视口。要放得下需 **视口 ≥ 1654px**。截图是 2551px 所以看起来正常；**1440 / 1512 笔电上一律溢出**（48% 分别只有 691 / 726px），且 `mx-auto` 在放不下时把内容推向右侧，只能靠横向滚动看右半页 —— 而"预览"这个栏位存在的意义就是"一眼看全"。

**修复方向**：预览列加缩放档位（`适配宽度 / 75% / 100%`），默认"适配宽度"用 `transform: scale()` + `origin-top` 包裹纸张（注意：分页测量必须在**未缩放**的隐藏副本上做，否则 `collectBlockMetrics` 的坐标会失真；此处已有 measure/display 双副本机制，缩放只作用于 display 侧即可）。若不想加 UI，至少给 `w-[210mm]` 加 `max-w-full` + 内部按容器宽等比缩放。

---

### I5 右侧浮动 dock 叠在预览列上

**证据**：`PreviewDock.tsx:78` `fixed right-3 top-1/2 z-[50]`，纵向排列 5 个按钮 + `MagicThread` + FAQ 圆钮；而预览是 48% 宽的滑动列，纸张左右各有 `pagePadding`（当前 32px，最小可调到 16px）留白。

**影响**：dock 宽约 56px + `right-3`，正好落在纸张右侧留白与内容区交界处；`pagePadding` 调到 16 或窗口变窄时直接压住正文末字，且 `z-50` 高于纸张 → 无法点击穿透。截图中它恰好停在留白里，属于"运气正确"。

**修复方向**：dock 不参与文档流时也应避开内容列 —— 改为挂在预览列的 `absolute`（而非视口 `fixed`）右内侧，或让纸张容器预留 `padding-right: 64px`；折叠面板已由顶栏/拖拽手柄承担，dock 可只留"回列表 + 帮助"。

---

### I6 两个按钮同时处于"激活"态

**证据**：`MarkdownEditor.tsx:96` `active={editor.isActive("paragraph") && !editor.isActive("heading")}`。列表项内部仍是 `listItem > paragraph`，因此光标落在无序列表里时，**「段落」与「无序列表」同时为 true**，两者都渲染 `bg-ink text-paper`（`:68`）。截图正是这个状态。

**影响**：激活态是工具栏唯一的强信号（设计注释明确写了"激活 = 墨色实底（唯一强态）"）。两个强态并列时，用户读到的是"这里既是段落又是列表"——把一个互斥状态渲染成了可叠加状态。

**修复方向**：段落按钮的判定补上容器排除：`!editor.isActive("bulletList") && !editor.isActive("orderedList")`。更稳的做法是把块类型做成**单选组**（paragraph / h1 / h2 / h3 一组，列表作为行内开关另组），从结构上消除双真。

---

### I7 「取消对齐」的图标与语义相反

**证据**：`MarkdownEditor.tsx:187-192` 用 `AlignJustify` 图标，`title={t("toolbar.alignNone")}`（中文"取消对齐（默认）"），`onClick={unsetAlign}`，**且未传 `active`**。

**影响**
- 图标语义 = 两端对齐，动作 = 清除对齐 → 用户以为在点 justify，实际把对齐清空；
- 它是四按钮组里唯一没有激活态的（其余三个用 `editor.isActive({ align })`，`:166-186`），视觉上读作"两端对齐未选中"，进一步强化误解。

**修复方向**：换成 `AlignLeft` 之外的"清除/重置"语义图标（如 `Eraser` / `Undo2` / `X`），或直接把该动作降级为"左对齐"（默认值），组内保持三选一。若保留"清除"，需补 `active={!editor.isActive({ align: "left" }) && !editor.isActive({ align: "center" }) && !editor.isActive({ align: "right" })}`。

---

## P2 详情

### I8 滑块无可见焦点

`globals.css` `.pp-slider` 声明 `outline: none` 且**全文无 `:focus-visible` 规则**（已检索确认），`::-webkit-slider-thumb` 也无焦点样式。四个 `input[type=range]`（`MarkdownWorkbench.tsx:152-162 / 169-179 / 193-203 / 210-220`）同时**没有 `aria-label`**，视觉上的 `<span>` 标签没有 `htmlFor` 关联 → 键盘用户 Tab 到滑块时既看不到焦点，也听不到名称。属 WCAG 2.4.7（焦点可见）+ 4.1.2（名称角色值）。

修：`.pp-slider:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--cobalt); }` + 每个 range 加 `aria-label`（复用已有 i18n key）。

### I9 字体与色板的可访问名

- 字体是 2×2 `<button>` 网格（`MarkdownWorkbench.tsx:120-138`），无 `role="radiogroup"` / `aria-pressed`，选中态仅靠 `bg-card shadow-sm` → 屏幕阅读器读不出发音当前选中项。
- 色板（`:229-243`）`aria-label={presetTheme}` 直接取十六进制（`#1A1A1A`）；`THEME_COLORS` 里 `#0047AB`（克莱因蓝）与 `#2563EB`（亮蓝）在 20px 圆点上几乎不可分辨，7 个色块均无名称。

修：字体组 `role="radiogroup"` + `aria-checked`；色板补中英文色名（墨黑/克莱因蓝/亮蓝/深红/橙/靛紫/海绿），并考虑合并两个蓝。

### I10 「Markdown 源」伪装成分段 tab

`zh.json` 里 `markdownEditor.editorTitle = "Markdown 源"`，渲染为 `<p className="xai-eyebrow">`（`MarkdownWorkbench.tsx:263-265`）。`.xai-eyebrow` 是 `mono + uppercase + letter-spacing: 0.08em`（`globals.css:407-412`）：

1. 视觉上读作「MARKDOWN | 源」两个 tab，用户会去点（截图中它就是唯一的"分栏标题"），而它不可点；
2. 汉字「源」被 +0.08em 字距拉散 —— 与本仓既定规则（中文小标签禁用 mono+uppercase+letter-spacing，应使用 `.eb-zh`）直接冲突。

修：文案改为「编辑」或「Markdown 编辑」，样式改用 `.eb-zh`；左栏标题「排版设置」同理检查（当前 `text-xs font-semibold` 已合规）。另：左栏图标 `ListChecks`（清单）与「排版设置」语义不符。

### I11 标题的两个真源

- 顶栏 `<Input defaultValue>` + `onBlur` 提交（`EditorHeader.tsx:172-181`）：输入过程中不生效，无 Enter 提交、无 Esc 取消、宽度固定 `w-56`（长标题被截断）。
- 正文 H1 来自 `markdownContent` 的首行。截图里预览 H1 为「宋哈娜 | 新建简历 45f671」→ **占位文档名被写进了成品简历**，用户以为改顶栏标题就会改 H1，实际不会。

修：明确二选一 —— 要么标题输入框改的是 H1（写回 markdown 首行），要么在 UI 上把二者区分（顶栏写「文件名」，H1 在编辑器内改），并在新建时用「姓名 | 职位」而非「姓名 | 新建简历 xxxxxx」做默认 H1。

### I12 两处常驻无限动画

- `EditorHeader.tsx:250-260`：错误徽标 `animate-pulse`，**永不停止、无关闭入口**。
- `PreviewDock.tsx:26-45` `MagicThread`：`repeat: Infinity` 的虚线脉冲，常驻编辑页。

修：徽标改为静态红点 + 计数（动画只在首次出现时播放一次）；`MagicThread` 删除或仅在 dock hover 时播放。

### I13 保存按钮的状态表达

`EditorHeader.tsx:266-283`：`disabled={savingMatch || !isDirty}` + `disabled:opacity-40`，Tooltip 用 `asChild` 包这个 `<button disabled>` —— **禁用元素不派发 pointer 事件，Radix Tooltip 因此不会显示**，于是"内容未改动，无需保存"这条解释性文案实际上看不到，用户只看到一个灰掉的主按钮。

另：该按钮 `bg-cobalt`（唯一信号色），与 `PreviewDock.tsx:153-158` 的"预览面板展开"高亮（`bg-primary`，HSL 236/100%/58%，等价于同一钴蓝）同屏争夺注意力 —— 后者只是**状态灯**，却用了与主操作相同的视觉权重。

修：Tooltip 触发器外包一层 `span`（或 `aria-disabled` + 提交时拦截）以保住提示；信号色只留给真正的下一步动作，状态用墨/橘。

### I14 输入路径的重渲染成本

- `MarkdownEditor.tsx:241` `shouldRerenderOnTransaction: true` → 每次事务（每个按键）重算 12 个 `isActive()` 并重渲工具栏。
- `onUpdate` → `updateResume` → 预览 `markdown === props` 变化 → `MarkdownPreview` 重跑 `renderMarkdownToHtml`、两个正则后处理、`variantCss`、分页 `useMemo`，并触发 `ResizeObserver` 测量（`:387-437`）。
- `EditorHeader.tsx:108-110` 每次 render 都对整个 `activeResume` 做 `JSON.stringify`（脏判定）。
- `EditorHeader.tsx:130-139` `useEffect` 依赖 `handleSaveMatch`（每次 render 新引用）→ **每个按键重绑一次 window keydown**。

影响：2 页简历尚可，长文档（多段项目经历）会出现输入延迟与光标抖动。修：`shouldRerenderOnTransaction: false` + 按需 `useEditorState` 订阅；预览侧对 `markdown` 做 120-200ms 防抖（测量与分页跟随防抖值）；脏判定改用递增 `revision` 计数器而非全量序列化；Cmd+S 用 `useRef` 持有 handler。

### I15 视觉令牌偏差

| 位置 | 现值 | 应为 | 依据 |
| --- | --- | --- | --- |
| 纸张阴影 `MarkdownPreview.tsx:258` | Tailwind `shadow-lg`（`0 10px 15px`，blur 15px 柔光） | 硬偏移 `var(--shadow-card)`（`4px 4px 0`） | `DESIGN.md`：禁 blur > 2px |
| 页码 `MarkdownPreview.tsx:305` | `text-gray-400` 硬编码 | `text-ink-3`（#75695C，5.0:1） | 令牌必须驱动，禁硬编码色 |
| 「A4」标签 `MarkdownWorkbench.tsx:293-295` | 静态 `<span>` 带边框 | 不可交互元素不应有控件外观；或做成真的纸张/缩放选择器 | 假 affordance |

另：编辑态正文用 `font-mono text-sm`（14px / `leading-relaxed` 1.625），产出态是 `baseFontSize 16 / lineHeight 1.5`（`MarkdownEditor.tsx:244-248` vs `MarkdownPreview.tsx:340-342`）→ **编辑区换行位置与预览不一致**，"实时预览"的预测价值被削弱；且 CJK 在 mono 栈下回退系统字体，中英混排基线略有不齐。

---

### I16 右侧 dock：一列并存三种体量、两种节奏、三级圆角

> 用户直接反馈：「右侧的按钮，高度都不一样，显得很业余丑陋」。实测成立，且根因不止一处。

**实测（截图原始像素，DPR 1，即 CSS px）**

纵向逐行扫描 dock 中轴（x=2519，容器内 x 2496..2543，内宽 **48px**）：

| 元素 | y 区间 | 可见高度 | 与上一项中心距 |
| --- | --- | --- | --- |
| 模板图标（字形） | 572..585 | **14** | — |
| 导出图标 | 612..625 | 13 | 40 |
| 复制图标 | 651..666 | 14 | 40 |
| 分隔线 | 683 | 1 | — |
| 眼睛（激活，实心方块） | 694..721 | **28** | 49 |
| 分隔线 | 732 | 1 | — |
| 首页图标 | 749..764 | 14 | 49 |
| 虚线线轴 | 790..~800 | — | — |
| FAQ（钴蓝圆钮） | 803..~890 | **38** | 53 |

**三条不一致，全部可量化**

1. **体量**：四个线图标可见高度 **13–14px**，激活态是 **28px 实心方块**（恰好 2×），底部 FAQ 是 **38px 圆形**。一列里三种尺寸、两种形状。
2. **节奏**：图标之间中心距 **40px**，跨分隔线变成 **49px**（多出 1px 线 + 两侧 `gap-2` 各 8px）。同一根竖轴上跑两套网格。
3. **圆角**：容器 `rounded-xl`(16px) / `DockIcon` `rounded-sm`(2px) / 按钮 `rounded-lg`(8px) —— 三级圆角同屏。

**根因（代码）**

- **双重盒子**：`PreviewDock.tsx:75` 按钮是 `h-7 w-7`（28px），却被 `DockIcon` 的 `size-8`（32px）外套包住（`magicui/dock.tsx:105-119`）。所有行的**外盒其实等高（32px）**，但只有眼睛那一行有可见填充 → 视觉上"高矮不齐"并非布局错乱，而是**只有一项被画成了块**。左右留白也随之分裂：容器内宽 48 − 32 = 8px，而 28px 按钮的图标两侧是 10 + 7 = 17px。
- **手写分隔线参与 flex 间距**：`PreviewDock.tsx:140` 与 `:171` 用 `<div className="h-[1px] w-full" />` 充当分组线，它落在 `gap-2` 的 flex 流里，白拿两份 8px 间距 → 40 → 49 的节奏断点。
- **hover 双层叠色**：`DockIcon` 的 32px 盒有 `hover:bg-muted`，其内 28px 按钮又有 `hover:bg-muted/50`（`PreviewDock.tsx:75` 的 `dockButtonClass`）。鼠标进入时同时亮起两个不同尺寸的圆角底 → 出现"双描边"式的脏边。
- **magicui `Dock` 的分组逻辑对当前用法完全空转**：`Dock` 会扫描 children 找 `TemplateSheet` 并切成三组、自动插分隔线（`dock.tsx:12-64`）；而 `PreviewDock` 只传了一个普通 `<div>`，`templateSheetIndex === -1`，于是走 fallback 分支（`p-2` + 内层 `gap-4`），magicui 的分隔线一次都没生效 —— 真正生效的是手写的那两条。留着一套不起作用的抽象，还多一层嵌套，间距由 `p-2` / `gap-4` / `gap-2` / `h-[1px]` 四方共同决定，谁动都容易破。
- **`whileHover={{ scale: 1.2 }}`**（`dock.tsx:108`）是 macOS 放大镜的移植，5 个纵向工具项不需要它；32px 盒 ×1.2 = 38.4px，hover 时反而**超过容器内宽 48 − 2×8 = 32px 的可用区**，紧贴边框。

**修复方向（一次性收口，不要逐点调）**

1. **一个尺寸**：全部做成 32px 行高 + **同一个 28px 可视 chip**；激活态只换色（`bg-cobalt text-paper`）不改尺寸、不改圆角。这样"选中"表达的是状态，不是体量。
2. **删掉手写分隔线**：改用一个 `gap-1` 的单一列表 + 分组用 `mt-2`（或 `divide-y` + `py-2`），节奏回到单一网格（40px）。
3. **圆角收敛到两级**：容器 12px、内部全部 8px；`DockIcon` 的 `size-8 + rounded-sm + hover:bg-muted` 要么删掉（让按钮自己承担 chip），要么让它成为唯一 chip。
4. **删掉 `scale 1.2`**，hover 只做 `bg-paper-2`；`whileTap` 保留 0.98 以内的轻微反馈。
5. **FAQ 圆钮与方块统一尺寸**（38 → 32 或直接 28），形状二选一，别在 60px 虚线后再换一种几何。

---

## 交互链路走查（按用户任务，不按组件）

| 任务 | 现状 | 断点 |
| --- | --- | --- |
| 写简历 → 看效果 | 左编辑右预览，逐键同步 | 编辑态字号/行高与产出态不同（I15）；窄屏看不到整页（I4） |
| 调排版 → 保住结果 | 左栏 5 个控件即时生效（内存） | **不知道要不要保存**（I1）；存了之后状态还说没存（I2） |
| 校对 → 修掉错字 | 顶栏「校对」→ 抽屉列错误 → 「应用」 | 第 2 页错误不可见（I3）；应用结果不确定（I3）；敲字后高亮消失（I3） |
| 导出 PDF | 顶栏「导出」/ dock「下载」两个入口 | 入口重复（I13 的同一信号色问题）；导出前的"是否已保存"无提示 |
| 切模板 / 复制简历 | 右侧 dock | dock 遮挡预览（I5）；一列三种体量与两套节奏（I16）；图标无标签，靠 tooltip（`delayDuration: 0` 一闪而过） |

---

## 修复路线图

按"信任 → 可用 → 打磨"三批，**每批内部可独立验证**。

| 批次 | 内容 | 完成判据 |
| --- | --- | --- |
| **第 1 批（信任）** | I1 + I2 同批（单一保存真源 + 脏基准上提到 store） | 任一处改动后顶栏状态点与实际落库状态一致；刷新页面设置不丢 |
| **第 2 批（可用）** | I4（缩放/适配宽度）+ I5（dock 避让）+ I6/I7（工具栏状态与图标） | 1512px 视口能看全整页；列表内不再出现双激活；四个对齐按钮语义自洽 |
| **第 3 批（正确性）** | I3（校对改源码区间定位 + 全页标记） | 2 页简历的错误在任意页可高亮、可定位、应用后正文确有变化 |
| **第 4 批（打磨）** | I8/I9（a11y）+ I10/I11（文案与双源）+ I12/I13/I14/I15/I16 | axe 核心规则通过；令牌零硬编码；dock 单一尺寸与节奏；长文档输入无可感延迟 |

> **不建议**先做第 4 批。I8/I9 是"加属性"级别的改动，成本低但收益要在真实键盘/读屏用户上才显现；而 I1/I2 影响的是每一个用户的每一次编辑。

---

## 交付前撤销的指控

| # | 初始怀疑 | 撤销理由 |
| --- | --- | --- |
| 1 | 「保存按钮用了紫色，偏离钴蓝 #2B3AFF」 | 截图 ICC 为 Display P3，原始像素 `(96,0,248)` 转 sRGB 后与 `--cobalt #2B3AFF` / `--primary`(236 100% 58%) 一致。**不是配色错误。** |
| 2 | 「左栏是『目标岗位 / 匹配预设』，与编辑器无关」 | 缩略图分辨率下误读。放大后确认左栏为「排版设置」（字体/字号行距/间距/主题色），与代码 `t("typeset.title")` 一致。 |
| 3 | 「顶栏标题与预览 H1 完全无关，属数据错乱」 | 二者确实不同源（保留为 I11），但预览 H1 由 markdown 首行渲染，链路本身正确，不是 bug。 |
| 4 | 「滑块太短，精度不足」 | 截图视口 2551px，滑块实际约 480px，拖动精度充足；仅在 <1280px 视口下才成立，未列入问题表。 |
| 5 | 「预览横向溢出」在截图现场成立 | 不成立（视口足够宽）。结论改写为"**常规笔电视口下**溢出"，并按 1654px 阈值给出量化判据（I4）。 |
| 6 | 「分页 1/2 页码与内容重叠」 | 页码在 `PageSheet` 底部绝对定位且 `pointer-events-none`（`MarkdownPreview.tsx:304-309`），实测落在页边距留白内，无重叠。 |
| 7 | 「顶栏有两个校对入口」 | `<GrammarCheckDrawer />` 只渲染一个无 trigger 的 Sheet，靠 `CustomEvent` 打开（`EditorHeader.tsx:239`、`:240-249`），屏幕只有一个「校对」按钮。属实现异味，非缺陷。 |

---

## 附：与 Paper & Punch 设计系统的偏差汇总

| 规则 | 现状 | 条目 |
| --- | --- | --- |
| 禁 blur > 2px 阴影 | 纸张 `shadow-lg`（blur 15px） | I15 |
| 令牌驱动，禁硬编码色 | 页码 `text-gray-400` | I15 |
| 中文小标签禁 mono + uppercase + letter-spacing | 面板标题「Markdown 源」用 `.xai-eyebrow` | I10 |
| 钴蓝 = 唯一信号色（表态"下一步做什么"） | 同时用于"保存"与"预览面板可见"状态灯 | I13 |
| 入场/常驻动画需可预期 | 两处 `repeat: Infinity` 常驻脉冲 | I12 |
| 控件边界 `--line-strong`、装饰线 `--line` | 已正确使用（顶栏按钮、分栏分隔线） | ✅ |
| 双密度 `[data-density]` 派生变量 | 本页未写 variant 分支，符合约定 | ✅ |
