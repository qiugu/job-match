import { Extension } from "@tiptap/core";
import { alignContainerPlugin } from "@/utils/markdownRender";

// 向 Tiptap 的命令类型注册表声明本扩展新增的命令，
// 否则 editor.chain().focus().setAlign(...) 会被 TS 判为不存在。
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    align: {
      /** 设置块的对齐方式（left / center / right） */
      setAlign: (align: string) => ReturnType;
      /** 清除块的对齐方式 */
      unsetAlign: () => ReturnType;
      /** 把一行拆成「同行左右分列」（:::left + :::right 配对行），产物与手写语法一致 */
      setAlignPair: () => ReturnType;
      /** 已在配对行则合并回单段，否则按当前选区/光标拆分配对 */
      toggleAlignPair: () => ReturnType;
    };
  }
}

/**
 * 对齐扩展（:::left / :::center / :::right）
 *
 * 为什么不能直接用 @tiptap/extension-text-align：
 * 1. 它的命令是 setTextAlign/unsetTextAlign，与工具栏的 setAlign/unsetAlign 不一致；
 * 2. 更关键的是 tiptap-markdown 的序列化器完全不认识 text-align（dist 中 align
 *    零出现），getMarkdown() 会把对齐静默丢弃 —— 编辑器里看着生效，存盘即丢失。
 *
 * 本扩展把对齐落成 markdown 容器语法，与预览管线（markdownRender.ts 的
 * alignContainerPlugin）打通，保证「编辑器 → markdown → 预览」端到端生效。
 *
 * 序列化产物（块形式，段落与标题一致，便于双向往返）：
 *   :::center
 *   # 宋哈娜
 *   :::
 *
 * 解析侧处理的三种标记形态（对应 markdownRender.ts 的三条产出路径）：
 *   1. 块容器        <div class="md-align-*"><p>…</p></div>   → 块级 align 属性
 *   2. 单段内联      <p><span class="md-align-*">X</span></p> → 段落 align 属性
 *   3. 多段内联配对  <p><span class="md-align-left">A</span><span class="md-align-right">B</span></p>
 *                     → 拆成两个对齐段落（Tiptap 无「同行左右分列」节点，
 *                       不拆就会被压平丢结构，见 splitInlineAlignPair）
 */
const ALIGN_NAMES = ["left", "center", "right"] as const;
type AlignName = (typeof ALIGN_NAMES)[number];

const isAlignName = (value: unknown): value is AlignName =>
  typeof value === "string" && (ALIGN_NAMES as readonly string[]).includes(value);

/** 从 md-align-* 类名里取出对齐名 */
const alignFromClass = (className: string): AlignName | null => {
  const matched = /(?:^|\s)md-align-(left|center|right)(?:\s|$)/.exec(className || "");
  return matched ? (matched[1] as AlignName) : null;
};

const BLOCK_SELECTOR = ":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6";
const INLINE_SPAN_SELECTOR =
  ":scope > span.md-align-left, :scope > span.md-align-center, :scope > span.md-align-right";

/** 是否为「对齐段落里的内联段」：直接子级的 <span class="md-align-*"> */
const isAlignSpan = (node: any): boolean =>
  node?.nodeType === 1 && node.tagName === "SPAN" && alignFromClass(node.className || "") !== null;

/**
 * 段落里除对齐 span 与空白外是否还有其它内容。
 *
 * 用于判断配对段落能否**安全**拆分：拆分过程中原段落会被移除，若其中还混有
 * 未被搬运的内容（裸文本、其它元素、注释），那些内容会随之消失。因此这里
 * 采用「白名单」判定 —— 只承认对齐 span 与纯空白文本，其余一律视为内容，
 * 遇到就放弃拆分（宁可维持现状，也不静默丢弃用户内容）。
 */
const hasOtherInlineContent = (paragraph: any): boolean =>
  Array.prototype.some.call(paragraph.childNodes, (node: any) => {
    if (isAlignSpan(node)) return false;
    if (node.nodeType === 3) return (node.textContent || "").trim() !== "";
    return true;
  });

/**
 * 把「同一行内多个对齐段」的段落拆成多个各自带 align 的段落。
 *
 * 背景：紧凑单行配对 `:::left A ::: :::right B :::` 经预览管线渲染为
 *   <p class="md-align-inline-pair"><span class="md-align-left">A</span>
 *   <span class="md-align-right">B</span></p>
 * 而 Tiptap 的文档模型里**没有**「同一行内左右分列」的节点 —— 多段 span 在
 * ProseMirror 解析时会被当无意义包装剥掉，子文本按文档顺序**无分隔符粘连**，
 * 容器与两侧对齐全部丢失（实测：`modern` 模板往返后 10 个 `:::` 容器变为 0 个，
 * 「138-0013-8000 · zhangsan@example.com」与「北京市朝阳区」粘连成一行）。
 *
 * 处理方式：在「markdown 渲染成 HTML 之后、交给 ProseMirror 之前」把配对段落
 * 拆成两个各自带 align 的段落。结构信息不再丢失；序列化时由
 * wrapAlignSerializer 输出为 `:::left` 块 + `:::right` 块，预览侧的
 * alignPairRow 规则会把相邻的 `:::left` / `:::right` 块**重新合并为同一行**
 * —— 与紧凑形式的渲染结果一致（`left-right` 模板本就原生使用块形式）。
 *
 * 取舍：Markdown 源会由紧凑形式变为块形式，且编辑器内该行显示为上下两段
 * （编辑器无「同行左右分列」节点，这是已知的 WYSIWYG 折中，非数据丢失）。
 *
 * @returns 是否发生了拆分
 */
const splitInlineAlignPair = (paragraph: any): boolean => {
  const spans = Array.prototype.filter.call(paragraph.childNodes, isAlignSpan);
  if (spans.length < 2) return false;
  if (hasOtherInlineContent(paragraph)) return false;

  const parent = paragraph.parentNode;
  const ownerDocument = paragraph.ownerDocument;
  if (!parent || !ownerDocument) return false;

  // 先校验齐备再改动 DOM：任一 span 取不出对齐名就整体放弃，
  // 避免「改了一半」把前半段搬走、后半段留在被移除的原段落里丢掉。
  const aligns: AlignName[] = [];
  for (const span of spans) {
    const align = alignFromClass(span.className || "");
    if (!align) return false;
    aligns.push(align);
  }

  spans.forEach((span: any, index: number) => {
    const block = ownerDocument.createElement("p");
    block.setAttribute("align", aligns[index]);
    // 搬运 span 的**子节点**而非文本：保留 strong / em / a 等行内标记
    while (span.firstChild) block.appendChild(span.firstChild);
    // 逐个插在原段落之前 ⇒ 顺序与源码一致
    parent.insertBefore(block, paragraph);
  });
  paragraph.remove();
  return true;
};

/**
 * 包装 tiptap-markdown 已有的段落/标题序列化器：带 align 属性的块输出成
 * `:::name\n<content>\n:::` 容器，否则完全走原逻辑。
 */
const wrapAlignSerializer = (base: (...args: any[]) => void) =>
  function alignedSerializer(this: any, state: any, node: any, parent: any, index: number) {
    const align = node?.attrs?.align;
    if (!isAlignName(align)) {
      return base.call(this, state, node, parent, index);
    }
    // 先写开容器，原序列化器写正文，最后闭合 —— 三者拼成完整的 ::: 块
    state.write(`:::${align}\n`);
    base.call(this, state, node, parent, index);
    state.write(":::\n");
  };

// =====================================================================
// 同行左右分列（配对行）：一键生成 / 合并 `:::left` + `:::right`
//
// 背景：简历里「公司 · 职位 | 日期」这类同一行左右分布，手写语法是
//   :::left 字节跳动 · 高级前端工程师 ::: :::right 2021.07 – 2024.12 :::
// 预览侧 alignPairRow 规则会把相邻的 `:::left`（或 `:::center`）+ `:::right`
// 块合并为同一行 flex（见 markdownRender.ts）。本节只做「一键拆分/合并」，
// 产物必须与手写语法完全一致 —— 序列化仍走 wrapAlignSerializer，预览零改动。
// =====================================================================

/** 对齐/配对命令作用的块类型（与扩展默认 options.types 保持一致） */
const ALIGN_BLOCK_TYPES = ["paragraph", "heading"] as const;

/** 配对行的左列对齐：left/center 均可（预览 alignPairRow 只认「非 right + right」） */
const isPairLeftAlign = (align: unknown): boolean => align === "left" || align === "center";

/** 两块是否构成预览侧的一行配对（判定条件与 alignPairRow 合并规则同构） */
const isPairRow = (leftNode: any, rightNode: any): boolean =>
  isPairLeftAlign(leftNode?.attrs?.align) && rightNode?.attrs?.align === "right";

/**
 * 找出与给定块构成配对行的兄弟块（只看父级 doc 的直接相邻兄弟）。
 * @returns { side, node, pos }：side=「本块是左列还是右列」；找不到返回 null
 */
const findPairSibling = (doc: any, pos: number, node: any) => {
  if (!doc || !node) return null;
  // 本块是右列 → 前邻兄弟为左列
  if (node.attrs?.align === "right") {
    const before = doc.childBefore(pos);
    if (before.node && isPairLeftAlign(before.node.attrs?.align)) {
      return { side: "left", node: before.node, pos: before.offset };
    }
  }
  // 本块是左列 → 后邻兄弟为右列
  if (isPairLeftAlign(node.attrs?.align)) {
    const after = doc.childAfter(pos + node.nodeSize);
    if (after.node && after.node.attrs?.align === "right") {
      return { side: "right", node: after.node, pos: after.offset };
    }
  }
  return null;
};

/**
 * 在 Fragment 的文本偏移层面找首/尾非空白范围。
 *
 * 为什么按文本偏移：textblock 的 content Fragment 里 marks 附着在文本节点上，
 * 文本偏移 == Fragment 偏移；非文本行内叶子（hardBreak 等）整段视为非空白，
 * 撑住修剪边界，避免把真实内容当空白裁掉。
 */
const findTrimRange = (fragment: any): { start: number; end: number } => {
  let start = fragment.size;
  let end = 0;
  let pos = 0;
  fragment.forEach((child: any) => {
    const size = child.nodeSize;
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i++) {
        if (!/\s/.test(child.text[i])) {
          const abs = pos + i;
          if (abs < start) start = abs;
          if (abs + 1 > end) end = abs + 1;
        }
      }
    } else if (size > 0) {
      if (pos < start) start = pos;
      if (pos + size > end) end = pos + size;
    }
    pos += size;
  });
  // 全空白：start > end，返回空区间
  return { start: Math.min(start, fragment.size), end: Math.max(end, start) };
};

/** 按需修剪片段两端空白（配对列内容干净，避免右列 nowrap 下露出缩进） */
const trimFragmentEdges = (fragment: any, trimStart: boolean, trimEnd: boolean): any => {
  if (!fragment || fragment.size === 0) return fragment;
  const range = findTrimRange(fragment);
  let from = 0;
  let to = fragment.size;
  if (trimStart) from = range.start;
  if (trimEnd) to = range.end;
  if (to <= from) return fragment.cut(0, 0);
  return fragment.cut(from, to);
};

/**
 * 把 textblock 内容按相对偏移三切为「前缀 | 选中 | 后缀」，空段返回 null。
 * 纯节点运算（content.cut / 空白修剪），不触碰 tr —— 便于 node 单测。
 *
 * @param parentNode 原块节点（paragraph/heading）
 * @param fromRel / toRel 相对块内容起点的偏移（0 <= fromRel <= toRel <= content.size）
 */
export const splitBlockFragments = (
  parentNode: any,
  fromRel: number,
  toRel: number
): { prefix: any | null; middle: any | null; suffix: any | null } => {
  const content = parentNode.content;
  const cut = (from: number, to: number, trimStart: boolean, trimEnd: boolean) => {
    const piece = trimFragmentEdges(content.cut(from, to), trimStart, trimEnd);
    return piece && piece.size > 0 ? piece : null;
  };
  return {
    prefix: fromRel > 0 ? cut(0, fromRel, false, true) : null,
    middle: cut(fromRel, toRel, true, true),
    suffix: toRel < content.size ? cut(toRel, content.size, true, false) : null,
  };
};

/** 配对左列的对齐值：原块为 center 时保持 center（预览允许 center+right 配对），否则 left */
const pairLeftColumnAlign = (originalAlign: unknown): "left" | "center" =>
  originalAlign === "center" ? "center" : "left";

/**
 * 配对布局决策表（纯函数，node 单测友好）。
 *
 * 依据交互契约（docs/PLAN_editor_align_selection.md）：
 * - 部分选区、选中前有内容：`[前缀 | 选中]` 左右分列，后缀顺延为下一段（继承原对齐）；
 * - 部分选区、选中贴行首（无前缀）：镜像布局 `[选中 | 后缀]` —— 若按字面产出
 *   「空左列 + 选中右列」，预览 alignPairRow 缺左列块根本合并不出同行，故取镜像；
 * - 光标拆（无选中内容）：`[光标前 | 光标后]`。
 *
 * @returns 各非空片段的归属与目标对齐；空片段不出现在结果里，结果 <2 项即构不成两列
 */
export const planPairLayout = (
  hasPrefix: boolean,
  hasSelection: boolean,
  hasSuffix: boolean,
  originalAlign: unknown = null
): Array<{ part: "prefix" | "middle" | "suffix"; align: "left" | "center" | "right" | null }> => {
  const left = pairLeftColumnAlign(originalAlign);
  const inherit = isAlignName(originalAlign) ? originalAlign : null;
  const plan: Array<{ part: "prefix" | "middle" | "suffix"; align: "left" | "center" | "right" | null }> = [];
  if (hasSelection && hasPrefix) {
    // [前缀 | 选中]，后缀顺延为下一段
    plan.push({ part: "prefix", align: left });
    plan.push({ part: "middle", align: "right" });
    if (hasSuffix) plan.push({ part: "suffix", align: inherit });
  } else if (hasSuffix) {
    // 光标拆 / 选中贴行首（镜像）：[前段 | 后段]
    if (hasPrefix) plan.push({ part: "prefix", align: left });
    else if (hasSelection) plan.push({ part: "middle", align: left });
    plan.push({ part: "suffix", align: "right" });
  }
  return plan;
};

/**
 * 定位 $pos 所在的顶层 textblock（父节点必须是 doc）。
 * 嵌套块（列表项/引用内）返回 null —— 在 list item 内拆出多段会破坏列表结构。
 */
const locateTopBlock = (
  $pos: any,
  types: readonly string[]
): { node: any; pos: number } | null => {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (types.includes(node.type?.name)) {
      const parent = $pos.node(depth - 1);
      if (!parent || parent.type?.name !== "doc") return null;
      return { node, pos: $pos.before(depth) };
    }
  }
  return null;
};

/**
 * 判定当前选区/光标下，配对按钮可用的动作：
 *   "merge" —— 光标/选区落在已有配对行内，点击应合并回单段；
 *   "split" —— 可拆出左右两列（部分选区 / 光标处拆 / 相邻两块配对）；
 *   null    —— 无法构成两列（整块选区、跨 >2 块、嵌套块、行首/行尾光标等）。
 *
 * 与 setAlignPair/toggleAlignPair 共用同一判定，保证「按钮可点」与「命令生效」一致。
 */
export const getPairAction = (
  state: any,
  types: readonly string[] = ALIGN_BLOCK_TYPES
): "split" | "merge" | null => {
  const selection = state?.selection;
  const doc = state?.doc;
  if (!selection || !doc) return null;

  const from = locateTopBlock(selection.$from, types);
  if (!from) return null;

  // 契约行 4：光标/选区落在已有配对行的任一列 → toggle 语义为「取消配对」。
  // 单块内部分选区若落在配对列上，同样优先合并，不再向下拆。
  if (findPairSibling(doc, from.pos, from.node)) return "merge";

  if (selection.empty) {
    // 光标在行中间（前后都有内容）才能拆出两列
    const rel = selection.from - (from.pos + 1);
    return rel > 0 && rel < from.node.content.size ? "split" : null;
  }

  const to = locateTopBlock(selection.$to, types);
  if (!to) return null;

  // 同一块内部分选区 → 拆分（[前缀 | 选中] 或镜像 [选中 | 后缀]）
  if (from.pos === to.pos) {
    const contentStart = from.pos + 1;
    const fromRel = selection.from - contentStart;
    const toRel = selection.to - contentStart;
    if (fromRel > 0 || toRel < from.node.content.size) return "split";
    return null; // 整块选区：没有自然拆点
  }

  // 恰好两个相邻顶层块 → 直接配对（内容不动）；
  // 已是配对行的情形已被上面的 merge 分支拦截
  if (to.pos === from.pos + from.node.nodeSize) return "split";
  return null; // 跨 >2 块或不相邻
};

/** 片段首/尾字符是否为空白（合并接缝判定；非文本叶子不当作空白） */
const fragmentEdgeIsWhitespace = (fragment: any, edge: "start" | "end"): boolean => {
  const node = edge === "start" ? fragment?.firstChild : fragment?.lastChild;
  if (!node?.isText || !node.text) return false;
  return edge === "start" ? /^\s/.test(node.text) : /\s$/.test(node.text);
};

/**
 * 把一行拆成「同行左右分列」的事务层（契约 1–3：部分选区 / 光标拆 / 相邻两块配对）。
 * 已是配对行的合并走 applyPairMerge。dispatch 为假时只做可行性判定、不改 tr
 * （tiptap canRun 惯例）。
 */
const applyPairSplit = (
  state: any,
  tr: any,
  dispatch: boolean | undefined,
  types: readonly string[]
): boolean => {
  if (getPairAction(state, types) !== "split") return false;

  const selection = state.selection;
  const from = locateTopBlock(selection.$from, types);
  const to = locateTopBlock(selection.$to, types);
  if (!from || !to) return false;

  // 契约 3：跨两个相邻顶层块 → 内容不动，直接配对。
  // 已是配对行的块对照走合并语义，这里防御性拒绝，绝不拆坏既有配对。
  if (from.pos !== to.pos) {
    if (isPairRow(from.node, to.node)) return false;
    if (dispatch) {
      tr.setNodeMarkup(from.pos, undefined, {
        ...from.node.attrs,
        align: pairLeftColumnAlign(from.node.attrs?.align),
      });
      tr.setNodeMarkup(to.pos, undefined, { ...to.node.attrs, align: "right" });
    }
    return true;
  }

  // 契约 1/2：单块内拆（部分选区 → [前缀 | 选中]；光标 → [光标前 | 光标后]）
  const node = from.node;
  const contentStart = from.pos + 1;
  const size = node.content.size;
  let fromRel: number;
  let toRel: number;
  if (selection.empty) {
    fromRel = toRel = selection.from - contentStart;
    if (fromRel <= 0 || fromRel >= size) return false;
  } else {
    fromRel = selection.from - contentStart;
    toRel = selection.to - contentStart;
    if (fromRel < 0 || toRel > size || fromRel >= toRel) return false;
    if (fromRel === 0 && toRel === size) return false; // 整块选区
  }

  const { prefix, middle, suffix } = splitBlockFragments(node, fromRel, toRel);
  const plan = planPairLayout(!!prefix, !!middle, !!suffix, node.attrs?.align);
  if (plan.length < 2) return false; // 构不成两列（如纯空白选区修剪后只剩单侧）

  const fragOf = (part: string) => (part === "prefix" ? prefix : part === "middle" ? middle : suffix);
  const newNodes = plan.map((entry) =>
    node.type.create({ ...node.attrs, align: entry.align }, fragOf(entry.part))
  );

  if (dispatch) {
    tr.replaceWith(from.pos, from.pos + node.nodeSize, newNodes);
    // 选区映射到替换后的区间（折叠到右列末尾）；拆分保持单条 undo
    tr.setSelection(state.selection.map(tr.doc, tr.mapping));
  }
  return true;
};

/**
 * 把配对行两列合并回单段（toggle 的取消侧）。
 * 接缝补一个空格：拆分时边界空白被修剪掉，若原文本接缝本无空格
 *（如「工程师2021」），合并会引入一个空格 —— 契约注明的取舍。
 */
const applyPairMerge = (
  state: any,
  tr: any,
  dispatch: boolean | undefined,
  types: readonly string[]
): boolean => {
  const doc = state.doc;
  const from = locateTopBlock(state.selection.$from, types);
  if (!from) return false;
  const sib = findPairSibling(doc, from.pos, from.node);
  if (!sib) return false;

  // 按文档顺序取左/右列
  const [left, right] = [
    { pos: from.pos, node: from.node },
    { pos: sib.pos, node: sib.node },
  ].sort((a, b) => a.pos - b.pos);

  const needSpace =
    left.node.content.size > 0 &&
    right.node.content.size > 0 &&
    !fragmentEdgeIsWhitespace(left.node.content, "end") &&
    !fragmentEdgeIsWhitespace(right.node.content, "start");
  let content = left.node.content;
  if (needSpace) {
    // 接缝补一个空格。注意不能用 Fragment.from()：@tiptap/core re-export 的
    // Fragment 类缺静态方法（实测 from/isFragment 均为 undefined），故用同类型
    // 节点包一个空格文本再取 .content，得到含空格文本的真 Fragment（实例方法可用）。
    const spaceFragment = left.node.type.create(null, state.schema.text(" ")).content;
    content = content.append(spaceFragment);
  }
  content = content.append(right.node.content);

  // 左列的块类型/attrs 承接（heading 等级等保留），对齐清掉
  const merged = left.node.type.create({ ...left.node.attrs, align: null }, content);

  if (dispatch) {
    tr.replaceWith(left.pos, right.pos + right.node.nodeSize, merged);
    tr.setSelection(state.selection.map(tr.doc, tr.mapping));
  }
  return true;
};

export const Align = Extension.create({
  name: "align",

  addOptions() {
    return {
      types: ["paragraph", "heading"] as string[],
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          align: {
            default: null,
            parseHTML: (element) => {
              const value = element.getAttribute("align");
              return isAlignName(value) ? value : null;
            },
            // 编辑器内即时可见（style 属性），保存时由序列化器转成 ::: 容器
            renderHTML: (attributes) => {
              if (!isAlignName(attributes.align)) return {};
              return { style: `text-align: ${attributes.align}` };
            },
            keepOnSplit: false,
          },
        },
      },
    ];
  },

  addCommands() {
    const applyToBlocks = (
      state: any,
      tr: any,
      dispatch: boolean | undefined,
      types: string[],
      align: AlignName | null
    ) => {
      let changed = false;
      const apply = (node: any, pos: number) => {
        if (!node || !types.includes(node.type?.name)) return;
        if (node.attrs?.align === align) return;
        if (dispatch) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, align });
        }
        changed = true;
      };

      const selection = state.selection;
      if (selection.empty) {
        // 光标无选区：作用于光标所在的块（向上找最近的 paragraph/heading）
        const $from = selection.$from;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (types.includes(node.type?.name)) {
            apply(node, $from.before(depth));
            break;
          }
        }
      } else {
        state.doc.nodesBetween(selection.from, selection.to, (node: any, pos: number) => {
          apply(node, pos);
          return true;
        });
      }
      return changed;
    };

    return {
      setAlign:
        (align: string) =>
        ({ state, tr, dispatch }: any) => {
          if (!isAlignName(align)) return false;
          return applyToBlocks(state, tr, dispatch, this.options.types, align);
        },
      unsetAlign:
        () =>
        ({ state, tr, dispatch }: any) =>
          applyToBlocks(state, tr, dispatch, this.options.types, null),
      setAlignPair:
        () =>
        ({ state, tr, dispatch }: any) =>
          applyPairSplit(state, tr, dispatch, this.options.types),
      toggleAlignPair:
        () =>
        ({ state, tr, dispatch }: any) => {
          const action = getPairAction(state, this.options.types);
          if (action === "merge") return applyPairMerge(state, tr, dispatch, this.options.types);
          return applyPairSplit(state, tr, dispatch, this.options.types);
        },
    };
  },

  addStorage() {
    return {
      // tiptap-markdown 会读取 extension.storage.markdown，
      // 其中 parse.setup / parse.updateDOM 对**所有**扩展生效（见其 MarkdownParser.parse）。
      markdown: {
        parse: {
          // 让编辑器的 markdown-it 认识 :::left/center/right（复用预览同一套规则）
          setup(md: any) {
            md.use(alignContainerPlugin);
          },
          // md 渲染成 HTML 后、交给 ProseMirror 解析前，把 md-align-* 容器
          // 拍平成带 align 属性的块元素，从而还原成节点属性。
          updateDOM(element: any) {
            if (!element?.querySelectorAll) return;

            // 块容器：<div class="md-align-left"><p>…</p></div> → <p align="left">…</p>
            element
              .querySelectorAll("div.md-align-left, div.md-align-center, div.md-align-right")
              .forEach((div: any) => {
                const align = alignFromClass(div.className || "");
                if (!align) return;
                div.querySelectorAll(BLOCK_SELECTOR).forEach((child: any) => {
                  child.setAttribute("align", align);
                });
                const parent = div.parentNode;
                if (!parent) return;
                while (div.firstChild) parent.insertBefore(div.firstChild, div);
                div.remove();
              });

            // 单行内联：<p><span class="md-align-left">X</span>…</p>
            // 直接从 span 反查，不依赖 <p> 上是否有额外 class，
            // 这样预览侧的标记结构怎么调整都不会影响编辑器解析。
            // 同一段落可能被多个 span 命中，先按段落去重，避免重复处理。
            const inlineParents: any[] = [];
            const seenParents = new Set<any>();
            element
              .querySelectorAll("span.md-align-left, span.md-align-center, span.md-align-right")
              .forEach((span: any) => {
                const p = span.parentElement;
                if (!p || p.tagName !== "P" || seenParents.has(p)) return;
                seenParents.add(p);
                inlineParents.push(p);
              });

            inlineParents.forEach((paragraph: any) => {
              const spans = paragraph.querySelectorAll(INLINE_SPAN_SELECTOR);

              // 单段：整段对齐，去掉 span 外壳即可
              if (spans.length === 1) {
                const align = alignFromClass(spans[0].className || "");
                if (!align) return;
                paragraph.setAttribute("align", align);
                while (spans[0].firstChild) paragraph.insertBefore(spans[0].firstChild, spans[0]);
                spans[0].remove();
                return;
              }

              // 多段（同一行内的左右配对等）：拆成多个各自带 align 的段落，
              // 避免被 ProseMirror 压平后丢失容器与对齐。详见 splitInlineAlignPair。
              splitInlineAlignPair(paragraph);
            });
          },
        },
      },
    };
  },

  onCreate() {
    // 包装段落/标题的 markdown 序列化器。
    //
    // 不能去改「某个名为 paragraph 的扩展」的 storage.markdown：
    // schema 里存在两个同名扩展（StarterKit 的与 tiptap-markdown 的），
    // 而 serializer.nodes 用 Object.fromEntries 构建，后出现的覆盖先出现的，
    // 用 extensions.find() 只能拿到第一个，改错对象就会静默失效（已实测踩坑）。
    //
    // 因此在 serializer 实例上拦截 nodes 这个 getter —— 无论最终生效的是
    // 哪一个扩展，取到的序列化器都会被包装。
    const storage: any = (this.editor.storage as any)?.markdown;
    const serializer = storage?.serializer;
    if (!serializer || (serializer as any).__alignPatched) return;

    const prototype = Object.getPrototypeOf(serializer);
    const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "nodes");
    if (!originalDescriptor?.get) return;

    const types = this.options.types;

    Object.defineProperty(serializer, "nodes", {
      configurable: true,
      get() {
        const base = (originalDescriptor.get as () => Record<string, any>).call(this) ?? {};
        const patched: Record<string, any> = { ...base };
        for (const name of types) {
          const target = base[name];
          if (typeof target !== "function" || (target as any).__alignWrapped) continue;
          const wrapped = wrapAlignSerializer(target);
          (wrapped as any).__alignWrapped = true;
          patched[name] = wrapped;
        }
        return patched;
      },
    });

    (serializer as any).__alignPatched = true;
  },
});

export default Align;
