import { Extension } from "@tiptap/core";
import { alignContainerPlugin } from "@/utils/markdownRender";

// 向 Tiptap 的命令类型注册表声明本扩展新增的命令，
// 否则 editor.chain().focus().setAlign(...) 会被 TS 判为不存在。
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    align: {
      /** 设置块的对齐方式（left / center / right）；单块内部分选区时只包裹选中文字 */
      setAlign: (align: string) => ReturnType;
      /** 清除块的对齐方式；单块内部分选区时只清除选中文字的对齐 */
      unsetAlign: () => ReturnType;
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
 * 作用域语义（2026-10-29 定稿，见 docs/PLAN_editor_align_selection.md）：
 * - **单块内部分选区** → 在选区边界拆块，只把「选中的文字」包裹成独立对齐块，
 *   前后片段原样保留（详见 wrapSelection）；
 * - 光标 / 整块选区 / 跨多块 / 嵌套块 → 沿用块级语义（作用于整块，与 Word 一致）。
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
 * 注意：本函数是**解析存量文档**所必需（模板中大量使用配对行），与工具栏
 * 命令无关 —— 2026-10-29 移除「同行左右分列」按钮后仍必须保留。
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
// 包裹选区：把「选中的文字」拆成独立对齐块
//
// 语义（docs/PLAN_editor_align_selection.md）：单块内部分选区时，在选区边界
// 拆成「前缀 | 选中 | 后缀」，只有选中片段得到目标对齐。序列化仍走
// wrapAlignSerializer（带 align 的段落自动输出 :::align 块），预览零改动 ——
// 孤立 :::right 走 markdownRender 的「单块 div」分支，渲染为独立右对齐行，
// 与编辑器内「两行」表现一致（不再是上一版配对方案的「编辑器两行/预览一行」）。
// =====================================================================

/**
 * 包裹路径的对齐归一：`left` 与「无对齐」渲染完全一致（都是默认左对齐），
 * 统一落成 null —— 既避免生成无意义的 :::left 容器，也避免 `left` + `right`
 * 相邻触发预览侧的配对合并（那会造成编辑器两行 / 预览一行）。
 */
const normalizeWrapAlign = (value: unknown): "center" | "right" | null =>
  value === "center" ? "center" : value === "right" ? "right" : null;

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

/** 按需修剪片段两端空白（包裹后的片段内容干净，避免行首尾挂空格） */
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
 * 「包裹选区」的事务层：单块内的部分选区 → 拆成「前缀 / 选中 / 后缀」，
 * 只有选中片段写入目标对齐（前缀与后缀继承原块对齐，`left` 归一为 null）。
 *
 * 返回值三态（调用方据此决定是否回落块级语义）：
 *   true  —— 已按包裹语义处理（dispatch=false 时为「判定可包裹」）；
 *   false —— 包裹路径明确无事可做（目标对齐与现状等价），不应回落老行为；
 *   null  —— 不适用（光标 / 整块 / 跨块 / 嵌套 / 纯空白选区）。
 */
const wrapSelection = (
  state: any,
  tr: any,
  dispatch: boolean | undefined,
  types: string[],
  align: AlignName | null
): boolean | null => {
  const selection = state.selection;
  // 防御：非文本选区或状态不完整（如只实现了基础字段的自定义 harness）时
  // 一律回落块级语义，避免读取 $from/$to 时报错。
  if (selection.empty || !selection.$from || !selection.$to) return null;

  const from = locateTopBlock(selection.$from, types);
  const to = locateTopBlock(selection.$to, types);
  // 跨块 / 嵌套块：回落块级语义（在 list item 内拆段会破坏列表结构）
  if (!from || !to || from.pos !== to.pos) return null;

  const node = from.node;
  const contentStart = from.pos + 1;
  const size = node.content.size;
  const fromRel = selection.from - contentStart;
  const toRel = selection.to - contentStart;
  if (fromRel < 0 || toRel > size || fromRel >= toRel) return null;
  // 整块选区：没有可包裹的「局部」，回落块级语义
  if (fromRel === 0 && toRel === size) return null;

  const inherit = normalizeWrapAlign(node.attrs?.align);
  const target = normalizeWrapAlign(align);
  // 与现状等价（left 与 null 渲染一致）：不产生新块，避免无意义的历史记录
  if (inherit === target) return false;

  const { prefix, middle, suffix } = splitBlockFragments(node, fromRel, toRel);
  // 纯空白选区：三切后中间为空，回落块级语义（与整块选区同款）
  if (!middle) return null;

  if (!dispatch) return true;

  const rebuild = (part: any, partAlign: "center" | "right" | null) =>
    node.type.create({ ...node.attrs, align: partAlign }, part);
  const nodes: any[] = [];
  if (prefix) nodes.push(rebuild(prefix, inherit));
  nodes.push(rebuild(middle, target));
  if (suffix) nodes.push(rebuild(suffix, inherit));

  tr.replaceWith(from.pos, from.pos + node.nodeSize, nodes);
  // 选区映射到替换后的区间（落在选中片段上）；整次包裹保持单条 undo
  tr.setSelection(state.selection.map(tr.doc, tr.mapping));
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

    /**
     * 对齐入口：优先「包裹选区」，不适用时回落块级语义。
     * 两条路径共用同一 align 值，保证「按钮行为」与「是否产生新块」一致。
     */
    const runAlign = (
      state: any,
      tr: any,
      dispatch: boolean | undefined,
      types: string[],
      align: AlignName | null
    ) => {
      const wrapped = wrapSelection(state, tr, dispatch, types, align);
      if (wrapped !== null) return wrapped;
      return applyToBlocks(state, tr, dispatch, types, align);
    };

    return {
      setAlign:
        (align: string) =>
        ({ state, tr, dispatch }: any) => {
          if (!isAlignName(align)) return false;
          return runAlign(state, tr, dispatch, this.options.types, align);
        },
      unsetAlign:
        () =>
        ({ state, tr, dispatch }: any) =>
          runAlign(state, tr, dispatch, this.options.types, null),
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
