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

            // 单行内联：<p><span class="md-align-left">X</span></p>
            // 直接从 span 反查，不依赖 <p> 上是否有额外 class，
            // 这样预览侧的标记结构怎么调整都不会影响编辑器解析。
            // 仅处理单段（left+right 双段无法映射为单一块属性，保持原样不改）
            element
              .querySelectorAll("span.md-align-left, span.md-align-center, span.md-align-right")
              .forEach((span: any) => {
                const p = span.parentElement;
                if (!p || p.tagName !== "P") return;
                const siblings = p.querySelectorAll(INLINE_SPAN_SELECTOR);
                if (siblings.length !== 1) return;
                const align = alignFromClass(span.className || "");
                if (!align) return;
                p.setAttribute("align", align);
                while (span.firstChild) p.insertBefore(span.firstChild, span);
                span.remove();
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
