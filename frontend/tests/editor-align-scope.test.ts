import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Align } from "@/components/editor/extensions/align";

/**
 * 编辑态对齐的**块级回落路径**回归测试（2026-09-11 建立，2026-10-29 更新）。
 *
 * 语义演进：2026-09-11 曾把「部分选区 → 整块生效」钉为契约；2026-10-29 产品
 * 决策改为「包裹选区」—— 单块内部分选区只把选中文字拆成独立对齐块
 * （节点级契约见 editor-align-selection.test.ts）。本文件因此只钉**块级回落**：
 * 整块选区 / 跨多块 / 光标 / 嵌套块这些「没有可包裹局部」的路径。
 *
 * 为什么这些路径仍是块级：`text-align` 是 CSS 的块级属性，不存在「行内局部
 * 对齐」；对整块或跨块选区而言，「作用于命中块」是唯一合理的模型
 * （Word / Google Docs 同款）。
 *
 * 同时钉住两个真实缺陷/易错点：
 * 1. 工具栏高亮判定：`isActive("align", { align })` 恒为 false（已修复）；
 * 2. 对齐是 paragraph/heading 上的**全局属性**，不是 schema 类型 —— 这是 1 的根因。
 */

const alignOptions = { types: ["paragraph", "heading"] };

interface FakeNode {
  type: { name: string };
  attrs: Record<string, unknown>;
}

interface FakeBlock {
  node: FakeNode;
  /** 块在文档中的起始位置（ProseMirror 坐标） */
  pos: number;
  /** 块的 nodeSize，用于判断选区是否与之相交 */
  size: number;
}

const paragraph = (text: string, attrs: Record<string, unknown> = {}): FakeNode => ({
  type: { name: "paragraph" },
  attrs: { align: null, ...attrs },
});

/** 构造一个只实现断言所需行为的 state / tr，避免为一条命令引入 DOM 环境 */
const makeHarness = (blocks: FakeBlock[], selection: Record<string, unknown>) => {
  const applied: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  const state = {
    selection,
    doc: {
      nodesBetween: (from: number, to: number, cb: (node: FakeNode, pos: number) => void) => {
        blocks
          .filter((b) => b.pos < to && b.pos + b.size > from)
          .forEach((b) => cb(b.node, b.pos));
      },
    },
  };
  const tr = {
    setNodeMarkup: (pos: number, _type: unknown, attrs: Record<string, unknown>) => {
      applied.push({ pos, attrs });
    },
  };
  return { state, tr, applied };
};

const runSetAlign = (
  align: string | null,
  blocks: FakeBlock[],
  selection: Record<string, unknown>
) => {
  const { state, tr, applied } = makeHarness(blocks, selection);
  // 自定义 harness 只需 options；`as any` 绕过 Tiptap 对 this/EditorState 的严格类型
  const commands = (Align.config.addCommands as any).call({ options: alignOptions });
  const changed = (
    align ? commands.setAlign(align) : commands.unsetAlign()
  )({ state, tr, dispatch: true });
  return { changed, applied };
};

describe("对齐的块级回落：选区只决定「作用于哪些块」", () => {
  const first: FakeBlock = { node: paragraph("专业技能"), pos: 0, size: 6 };
  const second: FakeBlock = { node: paragraph("工作经历"), pos: 6, size: 6 };

  it("整块选区 → 整块生效、不拆块（没有可包裹的「局部」）", () => {
    // 第二段 pos=6、size=6 ⇒ 内容区间 [7, 11)，此处选区恰好覆盖整块
    const { changed, applied } = runSetAlign("right", [first, second], {
      empty: false,
      from: 7,
      to: 11,
    });
    expect(changed).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0].pos).toBe(second.pos); // 整块，而不是新拆的片段
    expect(applied[0].attrs.align).toBe("right");
    // 未选中的块保持原样
    expect(applied.some((a) => a.pos === first.pos)).toBe(false);
  });

  it("选区跨越多个块 → 相交的块全部生效（Word/Google Docs 同款行为）", () => {
    const { applied } = runSetAlign("center", [first, second], {
      empty: false,
      from: 3,
      to: 9,
    });
    expect(applied.map((a) => a.pos).sort((x, y) => x - y)).toEqual([0, 6]);
    expect(applied.every((a) => a.attrs.align === "center")).toBe(true);
  });

  it("无选区（仅光标）→ 只作用于光标所在块", () => {
    const $from = {
      depth: 1,
      node: (depth: number) => (depth === 1 ? second.node : { type: { name: "doc" }, attrs: {} }),
      before: (depth: number) => (depth === 1 ? second.pos : 0),
    };
    const { changed, applied } = runSetAlign("left", [first, second], { empty: true, $from });
    expect(changed).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0].pos).toBe(second.pos);
    expect(applied[0].attrs.align).toBe("left");
  });

  it("已是对齐值时不重复写入（返回 false，避免无意义的历史记录）", () => {
    const already: FakeBlock = {
      node: paragraph("工作经历", { align: "right" }),
      pos: 6,
      size: 6,
    };
    const { changed, applied } = runSetAlign("right", [first, already], {
      empty: false,
      from: 7,
      to: 9,
    });
    expect(changed).toBe(false);
    expect(applied).toHaveLength(0);
  });

  it("写入时保留块上的其它属性（不整块覆盖 attrs）", () => {
    const withAttrs: FakeBlock = {
      node: paragraph("工作经历", { textAlignNote: "keep-me" }),
      pos: 6,
      size: 6,
    };
    const { applied } = runSetAlign("right", [first, withAttrs], {
      empty: false,
      from: 7,
      to: 9,
    });
    expect(applied[0].attrs).toMatchObject({ textAlignNote: "keep-me", align: "right" });
  });
});

describe("对齐属性的注册方式决定了高亮判定写法", () => {
  it("align 是 paragraph/heading 的全局属性，schema 里没有名为 align 的类型", () => {
    const attributes = (Align.config.addGlobalAttributes as any).call({ options: alignOptions });
    expect(attributes).toHaveLength(1);
    expect(attributes[0].types).toEqual(["paragraph", "heading"]);
    expect(Object.keys(attributes[0].attributes)).toEqual(["align"]);
    // 因此 isActive("align", …) 走不通：Tiptap 的 getSchemaTypeNameByName("align")
    // 返回 null 后会直接判 false，按钮永远不高亮。
  });

  it("工具栏只使用「仅属性」的 isActive 形式", () => {
    const raw = readFileSync(
      fileURLToPath(
        new URL("../src/components/editor/MarkdownEditor.tsx", import.meta.url)
      ),
      "utf8"
    );
    // 必须剥离注释后再扫描：修复说明的注释里正引用了那个错误写法，
    // 不剥离会把「说明文字」当成「真实调用」误判（本用例第一版即如此失败）。
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    expect(source).not.toMatch(/isActive\(\s*"align"/);
    const attributeForm = source.match(/isActive\(\{\s*align:/g) ?? [];
    expect(attributeForm).toHaveLength(3); // 居左 / 居中 / 居右
  });
});
