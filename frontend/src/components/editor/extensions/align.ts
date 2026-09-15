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
