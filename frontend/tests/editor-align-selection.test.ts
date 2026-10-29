import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Align, splitBlockFragments } from "@/components/editor/extensions/align";
import { renderMarkdownToHtml } from "@/utils/markdownRender";

/**
 * 「包裹选区」语义的节点级契约（2026-10-29）。
 *
 * 契约来源：docs/PLAN_editor_align_selection.md。
 * 一句话语义：**单块内的部分选区 → 只把选中的文字拆成独立对齐块**，
 * 前后片段原样保留；其余路径（光标 / 整块 / 跨块 / 嵌套）回落块级语义
 * （由 editor-align-scope.test.ts 钉住）。
 *
 * 分层：本文件在 node 环境用**真实 schema / doc / Fragment**（经 @tiptap/core
 * re-export）验证命令产物；DOM 与序列化端到端由
 * frontend/scripts/editor-probe/ 在真实 Chromium 中验证（vitest 无 jsdom）。
 */

// Align 一并喂给 getSchema，paragraph/heading 才带 align 全局属性
const schema = getSchema([StarterKit, Align]);
const para = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.nodes.paragraph.create({ align: null, ...attrs }, text ? schema.text(text) : null);
const heading = (text: string, level = 2, attrs: Record<string, unknown> = {}) =>
  schema.nodes.heading.create({ level, align: null, ...attrs }, text ? schema.text(text) : null);
const docOf = (...blocks: any[]) => schema.nodes.doc.create(null, blocks);
const blockquote = (...blocks: any[]) => schema.nodes.blockquote.create(null, blocks);

/** 文档中第 index 个顶层块的起始位置（ProseMirror 坐标） */
const blockPos = (docNode: any, index: number) => {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += docNode.child(i).nodeSize;
  return pos;
};

interface Applied {
  from: number;
  to: number;
  nodes: any[];
}

/**
 * 最小 state / tr：
 * - `$from` / `$to` 用真实 `doc.resolve()`（Resolve 提供 depth / node / before）；
 * - `tr` 只记录 replaceWith / setNodeMarkup，不构造真实 Transform
 *   （pnpm 隔离下 prosemirror-transform 不可直接解析，已实测）。
 */
const makeHarness = (docNode: any, from: number, to: number) => {
  const $from = docNode.resolve(from);
  const $to = docNode.resolve(to);
  const selection: any = { empty: from === to, from, to, $from, $to };
  selection.map = () => selection;

  const replaced: Applied[] = [];
  const markups: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  const tr = {
    doc: docNode,
    mapping: {},
    replaceWith(start: number, end: number, nodes: any) {
      replaced.push({ from: start, to: end, nodes: Array.isArray(nodes) ? nodes : [nodes] });
    },
    setNodeMarkup(pos: number, _type: unknown, attrs: Record<string, unknown>) {
      markups.push({ pos, attrs });
    },
    setSelection() {
      /* no-op：选区回落不影响本文件的断言 */
    },
  };

  return { state: { doc: docNode, selection }, tr, replaced, markups };
};

const options = { types: ["paragraph", "heading"] };
const commands = (Align.config.addCommands as any).call({ options });

const runAlign = (
  align: string | null,
  docNode: any,
  from: number,
  to: number
) => {
  const h = makeHarness(docNode, from, to);
  const changed = (align ? commands.setAlign(align) : commands.unsetAlign())({
    state: h.state,
    tr: h.tr,
    dispatch: true,
  });
  return { changed, ...h };
};

// =====================================================================
// 一、三切（纯节点运算）
// =====================================================================

describe("splitBlockFragments：按选区三切并修剪两端空白", () => {
  const text = "公司 职位 日期"; // 0公 1司 2空格 3职 4位 5空格 6日 7期
  const node = para(text);

  const pieceText = (piece: any) => (piece ? piece.textBetween(0, piece.size, "") : null);

  it("中间选区 → 前缀 / 选中 / 后缀 三段齐全，剪掉边界空格", () => {
    const cut = splitBlockFragments(node, 3, 5);
    expect(pieceText(cut.prefix)).toBe("公司");
    expect(pieceText(cut.middle)).toBe("职位");
    expect(pieceText(cut.suffix)).toBe("日期");
  });

  it("选区贴行首 → 没有前缀", () => {
    const cut = splitBlockFragments(node, 0, 3);
    expect(cut.prefix).toBeNull();
    expect(pieceText(cut.middle)).toBe("公司");
    expect(pieceText(cut.suffix)).toBe("职位 日期");
  });

  it("选区贴行尾 → 没有后缀", () => {
    const cut = splitBlockFragments(node, 5, 8);
    expect(pieceText(cut.prefix)).toBe("公司 职位");
    expect(pieceText(cut.middle)).toBe("日期");
    expect(cut.suffix).toBeNull();
  });

  it("纯空白选区 → 中间为空（调用方据此回落块级语义）", () => {
    const cut = splitBlockFragments(node, 2, 3); // 只有一个空格
    expect(cut.middle).toBeNull();
  });
});

// =====================================================================
// 二、命令：包裹选区
// =====================================================================

describe("setAlign 包裹选区：只让选中的文字获得对齐", () => {
  const text = "公司 职位 日期";
  const node = para(text);
  const docNode = docOf(node);
  const contentStart = 1; // 单段文档：段落起始 0，内容从 1 开始
  const rel = (offset: number) => contentStart + offset;

  it("中间选区 → 拆 3 段，只有中间段写入目标对齐", () => {
    const { changed, replaced } = runAlign("right", docNode, rel(3), rel(5));
    expect(changed).toBe(true);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].nodes).toHaveLength(3);

    const [prefix, middle, suffix] = replaced[0].nodes;
    expect(prefix.textContent).toBe("公司");
    expect(middle.textContent).toBe("职位");
    expect(suffix.textContent).toBe("日期");
    expect(middle.attrs.align).toBe("right");
    // 前后片段回到默认对齐（原块无对齐）
    expect(prefix.attrs.align).toBeNull();
    expect(suffix.attrs.align).toBeNull();
  });

  it("替换区间恰好覆盖原块（单条 undo，不残留旧块）", () => {
    const { replaced } = runAlign("right", docNode, rel(3), rel(5));
    expect(replaced[0].from).toBe(0);
    expect(replaced[0].to).toBe(node.nodeSize);
  });

  it("选区贴行尾 → 只拆 2 段（前缀 + 选中）", () => {
    const { replaced } = runAlign("right", docNode, rel(5), rel(8));
    expect(replaced[0].nodes.map((n: any) => n.textContent)).toEqual(["公司 职位", "日期"]);
    expect(replaced[0].nodes[1].attrs.align).toBe("right");
  });

  it("选区贴行首 → 只拆 2 段（选中 + 后缀）", () => {
    const { replaced } = runAlign("right", docNode, rel(0), rel(2));
    expect(replaced[0].nodes.map((n: any) => n.textContent)).toEqual(["公司", "职位 日期"]);
    expect(replaced[0].nodes[0].attrs.align).toBe("right");
  });

  it("标题拆分保留级别（heading level 不被拆丢）", () => {
    const head = heading("字节跳动 · 高级前端工程师 2021.07 – 2024.12", 2);
    const hDoc = docOf(head);
    // "字节跳动 · 高级前端工程师 " 共 13 个字符 → 日期从 13 开始
    const { replaced } = runAlign("right", hDoc, 1 + 13, 1 + head.textContent.length);
    const nodes = replaced[0].nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n: any) => n.type.name === "heading")).toBe(true);
    expect(nodes.every((n: any) => n.attrs.level === 2)).toBe(true);
    expect(nodes[1].attrs.align).toBe("right");
  });

  it("原块居中 → 前后片段继承居中（「前后文字原样」）", () => {
    const centered = para(text, { align: "center" });
    const { replaced } = runAlign("right", docOf(centered), rel(3), rel(5));
    const [prefix, middle, suffix] = replaced[0].nodes;
    expect(prefix.attrs.align).toBe("center");
    expect(middle.attrs.align).toBe("right");
    expect(suffix.attrs.align).toBe("center");
  });

  it("原块 align=left → 继承值归一为 null（left 与默认渲染一致，且不触发预览配对）", () => {
    const lefted = para(text, { align: "left" });
    const { replaced } = runAlign("right", docOf(lefted), rel(3), rel(5));
    const [prefix, , suffix] = replaced[0].nodes;
    expect(prefix.attrs.align).toBeNull();
    expect(suffix.attrs.align).toBeNull();
  });

  it("unsetAlign 部分选区 → 只清掉选中段的对齐，两侧继承原值", () => {
    const righted = para(text, { align: "right" });
    const { replaced } = runAlign(null, docOf(righted), rel(3), rel(5));
    const [prefix, middle, suffix] = replaced[0].nodes;
    expect(prefix.attrs.align).toBe("right");
    expect(middle.attrs.align).toBeNull();
    expect(suffix.attrs.align).toBe("right");
  });

  it("中心对齐块点「居左」→ 中间段落 null（left 归一），前后仍居中", () => {
    const centered = para(text, { align: "center" });
    const { replaced } = runAlign("left", docOf(centered), rel(3), rel(5));
    const [prefix, middle, suffix] = replaced[0].nodes;
    expect(middle.attrs.align).toBeNull();
    expect(prefix.attrs.align).toBe("center");
    expect(suffix.attrs.align).toBe("center");
  });
});

// =====================================================================
// 三、no-op：目标对齐与现状等价时不产生新块
// =====================================================================

describe("目标对齐与现状等价 → 返回 false，不产生历史记录", () => {
  const text = "公司 职位 日期";

  it("已居右的块再次点「居右」（部分选区） → 不拆块", () => {
    const { changed, replaced, markups } = runAlign("right", docOf(para(text, { align: "right" })), 4, 6);
    expect(changed).toBe(false);
    expect(replaced).toHaveLength(0);
    expect(markups).toHaveLength(0);
  });

  it("默认对齐的块点「居左」（部分选区） → 不拆块（left 与 null 渲染一致）", () => {
    const { changed, replaced, markups } = runAlign("left", docOf(para(text)), 4, 6);
    expect(changed).toBe(false);
    expect(replaced).toHaveLength(0);
    expect(markups).toHaveLength(0);
  });

  it("显式 :::left 块点「居左」（部分选区） → 同样不拆块", () => {
    const { changed, replaced } = runAlign("left", docOf(para(text, { align: "left" })), 4, 6);
    expect(changed).toBe(false);
    expect(replaced).toHaveLength(0);
  });
});

// =====================================================================
// 四、回落块级语义（不拆块）
// =====================================================================

describe("没有可包裹的「局部」→ 回落块级语义（作用于整块）", () => {
  const text = "公司 职位 日期";

  it("整块选区 → setNodeMarkup，不拆块", () => {
    const node = para(text);
    const { changed, replaced, markups } = runAlign("right", docOf(node), 1, 1 + text.length);
    expect(changed).toBe(true);
    expect(replaced).toHaveLength(0);
    expect(markups).toHaveLength(1);
    expect(markups[0].pos).toBe(0);
    expect(markups[0].attrs.align).toBe("right");
  });

  it("光标（无选区）→ 只作用于光标所在块", () => {
    const node = para(text);
    const { changed, replaced, markups } = runAlign("center", docOf(node), 4, 4);
    expect(changed).toBe(true);
    expect(replaced).toHaveLength(0);
    expect(markups).toHaveLength(1);
    expect(markups[0].attrs.align).toBe("center");
  });

  it("跨两段选区 → 两段各自生效", () => {
    const first = para("专业技能");
    const second = para("工作经历");
    const docNode = docOf(first, second);
    const { replaced, markups } = runAlign("right", docNode, 2, blockPos(docNode, 1) + 2);
    expect(replaced).toHaveLength(0);
    expect(markups.map((m) => m.pos).sort((a, b) => a - b)).toEqual([0, blockPos(docNode, 1)]);
    expect(markups.every((m) => m.attrs.align === "right")).toBe(true);
  });

  it("嵌套块（引用内的段落）→ 不拆段，避免破坏容器结构", () => {
    const inner = para(text);
    const docNode = docOf(blockquote(inner));
    // 引用起始 0，内部段落起始 1，其内容从 2 开始
    const { replaced, markups } = runAlign("right", docNode, 2 + 3, 2 + 5);
    expect(replaced).toHaveLength(0);
    expect(markups).toHaveLength(1);
    expect(markups[0].pos).toBe(1);
    expect(markups[0].attrs.align).toBe("right");
  });

  it("纯空白选区 → 回落块级语义（中间段为空，无可包裹内容）", () => {
    const node = para(text);
    const { replaced, markups } = runAlign("right", docOf(node), 3, 4); // 只有空格
    expect(replaced).toHaveLength(0);
    expect(markups).toHaveLength(1);
  });
});

// =====================================================================
// 五、渲染一致性：孤立 :::right 不得被合并成同一行
// =====================================================================

describe("包裹产物在预览侧的形态：独立右对齐行（与编辑器两行一致）", () => {
  it("孤立的 :::right 块不触发配对合并", () => {
    const html = renderMarkdownToHtml("公司 职位\n\n:::right\n日期\n\n:::");
    expect(html).toContain("md-align-right");
    // 配对容器是「同一行左右分布」的标志；包裹语义下必须缺席
    expect(html).not.toContain("md-pair-row");
  });

  it("手写配对仍然合并（既有版式能力不受本次改动影响）", () => {
    const html = renderMarkdownToHtml(":::left\n公司 职位\n\n:::\n:::right\n日期\n\n:::");
    expect(html).toContain("md-pair-row");
  });
});
