import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  Align,
  getPairAction,
  planPairLayout,
  splitBlockFragments,
} from "@/components/editor/extensions/align";

/**
 * 「同行左右分列」按钮的交互契约测试（2026-10-28）。
 *
 * 契约来源：docs/PLAN_editor_align_selection.md（用户拍板：对齐按钮语义不动，
 * 新增按钮用既有 :::left / :::right 语法一键生成同行左右分列）：
 *   行 1 部分选区（单块内）→ [前缀 | 选中] 左右分列，后缀顺延下一段
 *   行 2 光标在行中间      → 在光标处拆 [光标前 | 光标后]
 *   行 3 跨两个相邻顶层块  → 上段左列、下段右列（内容不动）
 *   行 4 落在已有配对行    → toggle 合并回单段
 *   行 5 整块选区/行首行尾光标/嵌套块 → 按钮禁用
 *
 * 分层：本文件在 node 环境用**真实 schema/doc/Fragment**（@tiptap/core re-export，
 * 无需 prosemirror 直依赖）验证纯函数与命令产物；DOM/序列化端到端由
 * frontend/scripts/editor-probe/ 在真实 Chromium 中验证（vitest 无 jsdom）。
 */

// Align 一并喂给 getSchema，paragraph/heading 才带 align 全局属性
const schema = getSchema([StarterKit, Align]);
const p = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.nodes.paragraph.create({ align: null, ...attrs }, text ? schema.text(text) : null);
const h = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.nodes.heading.create({ align: null, level: 2, ...attrs }, text ? schema.text(text) : null);
const docOf = (...blocks: any[]) => schema.nodes.doc.create(null, blocks);

// Fragment 没有 textContent（那是 Node 的属性），取文本用 textBetween
const fragText = (f: any): string | null => (f ? f.textBetween(0, f.size, "") : null);

/**
 * 用真实 ResolvedPos 伪装 selection（vitest 无 jsdom，不建完整 EditorState）。
 * 注意：传入的是 **doc 坐标**；单块文档中内容从 pos 1 开始（contentStart = pos + 1）。
 */
const sel = (doc: any, from: number, to = from) => ({
  empty: from === to,
  from,
  to,
  $from: doc.resolve(from),
  $to: doc.resolve(to),
  map: () => ({ empty: true }), // 事务里 setSelection 的占位
});

const options = { types: ["paragraph", "heading"] };
// 鸭子类型 harness：命令经 addCommands.call 注入 options（与 editor-align-scope 同模式）。
// as any 规避 Tiptap 配置对象的严格 this/可选性检查 —— 仅测试用，运行时行为由用例断言。
const commands: any = (Align.config.addCommands as any).call({ options });

/** 命令级 harness：真实 doc/节点 + 记录型 tr（参照 editor-align-scope.test.ts） */
const runCommand = (name: "setAlignPair" | "toggleAlignPair", doc: any, selection: any) => {
  const calls: { replaceWith: any[][]; setNodeMarkup: any[][]; setSelection: number } = {
    replaceWith: [],
    setNodeMarkup: [],
    setSelection: 0,
  };
  const tr = {
    doc,
    mapping: {},
    replaceWith: (...args: any[]) => calls.replaceWith.push(args),
    setNodeMarkup: (...args: any[]) => calls.setNodeMarkup.push(args),
    setSelection: () => {
      calls.setSelection += 1;
    },
  };
  const state = { doc, selection, schema };
  const changed = commands[name]()({ state, tr, dispatch: true });
  return { changed, calls };
};

// =====================================================================
// 一、splitBlockFragments：Fragment 三切（marks 保留、边界空白修剪）
// =====================================================================
describe("splitBlockFragments：按相对偏移三切 textblock 内容", () => {
  it("选区在行尾 → [前缀 | 选中]，无后缀", () => {
    const node = p("字节跳动 · 高级前端工程师 2021.07 – 2024.12");
    // 「2021」起始偏移：前缀含尾随空格，修剪后不带入列内容
    const fromRel = node.content.size - "2021.07 – 2024.12".length;
    const { prefix, middle, suffix } = splitBlockFragments(node, fromRel, node.content.size);
    expect(fragText(prefix)).toBe("字节跳动 · 高级前端工程师");
    expect(fragText(middle)).toBe("2021.07 – 2024.12");
    expect(suffix).toBeNull();
  });

  it("选区在行首 → 无前缀；选区在行中 → 三段俱全", () => {
    const node = p("ABCDE");
    const head = splitBlockFragments(node, 0, 2);
    expect(head.prefix).toBeNull();
    expect(fragText(head.middle)).toBe("AB");
    expect(fragText(head.suffix)).toBe("CDE");

    const mid = splitBlockFragments(node, 1, 3);
    expect(fragText(mid.prefix)).toBe("A");
    expect(fragText(mid.middle)).toBe("BC");
    expect(fragText(mid.suffix)).toBe("DE");
  });

  it("接缝空白随修剪丢弃：选中前后各留干净内容", () => {
    const node = p("left   mid   right");
    // 选中「   mid   」（含两侧空格）→ 三段内容都不得残留边界空白
    const { prefix, middle, suffix } = splitBlockFragments(node, 4, 12);
    expect(fragText(prefix)).toBe("left");
    expect(fragText(middle)).toBe("mid");
    expect(fragText(suffix)).toBe("right");
  });

  it("行内标记（bold 等）随 Fragment.cut 留在原侧", () => {
    const bold = schema.marks.bold.create();
    const node = schema.nodes.paragraph.create(
      null,
      schema.text("公司日期", [bold]) // 全程 bold，切割后各自保持
    );
    const cutAt = 2;
    const { prefix, middle } = splitBlockFragments(node, cutAt, node.content.size);
    expect(fragText(prefix)).toBe("公司");
    expect(fragText(middle)).toBe("日期");
    expect(middle?.firstChild?.marks?.some((m: any) => m.type.name === "bold")).toBe(true);
  });

  it("纯空白选区修剪后为空 → middle 为 null（命令层退化为光标拆或拒绝）", () => {
    const node = p("AB  CD");
    const { middle } = splitBlockFragments(node, 2, 4);
    expect(middle).toBeNull();
  });
});

// =====================================================================
// 二、planPairLayout：配对布局决策表
// =====================================================================
describe("planPairLayout：片段归属与对齐的决策表", () => {
  it("行 1：部分选区（选中在行尾）→ [前缀 left | 选中 right]", () => {
    expect(planPairLayout(true, true, false, null)).toEqual([
      { part: "prefix", align: "left" },
      { part: "middle", align: "right" },
    ]);
  });

  it("行 1 变体：选中在行中，后缀顺延并继承原对齐", () => {
    expect(planPairLayout(true, true, true, "right")).toEqual([
      { part: "prefix", align: "left" },
      { part: "middle", align: "right" },
      { part: "suffix", align: "right" }, // 继承原块对齐
    ]);
  });

  it("选中贴行首 → 镜像布局 [选中 left | 后缀 right]（空左列合不出同行，取镜像）", () => {
    expect(planPairLayout(false, true, true, null)).toEqual([
      { part: "middle", align: "left" },
      { part: "suffix", align: "right" },
    ]);
  });

  it("行 2：光标拆 → [光标前 left | 光标后 right]", () => {
    expect(planPairLayout(true, false, true, null)).toEqual([
      { part: "prefix", align: "left" },
      { part: "suffix", align: "right" },
    ]);
  });

  it("原块居中时左列保持 center（预览 alignPairRow 允许 center+right）", () => {
    expect(planPairLayout(true, true, false, "center")).toEqual([
      { part: "prefix", align: "center" },
      { part: "middle", align: "right" },
    ]);
  });

  it("构不成两列的组合 → 结果 <2 项（命令层返回 false）", () => {
    // 选中 = 整块内容 / 光标在行尾（无右列）→ 均构不成两列
    expect(planPairLayout(false, true, false, null).length).toBeLessThan(2);
    expect(planPairLayout(true, false, false, null).length).toBeLessThan(2);
    // 光标拆的正常形态仍是两项
    expect(planPairLayout(true, false, true, null)).toHaveLength(2);
  });
});

// =====================================================================
// 三、getPairAction：交互契约 5 态决策
// =====================================================================
describe("getPairAction：按钮可用动作判定（契约 5 态）", () => {
  const line = "字节跳动 · 高级前端工程师 2021.07 – 2024.12";
  const docOne = docOf(p(line));
  const size = docOne.firstChild!.content.size;

  it("行 1：单块内部分选区 → split；整块选区 → 禁用", () => {
    // doc 坐标：内容从 pos 1 起，[size-3, size+1) 即行尾一小段
    expect(getPairAction({ doc: docOne, selection: sel(docOne, size - 3, size + 1) })).toBe("split");
    // 整块：[内容起点, 内容终点]
    expect(getPairAction({ doc: docOne, selection: sel(docOne, 1, size + 1) })).toBeNull();
  });

  it("行 2：光标在行中间 → split；行首/行尾光标 → 禁用", () => {
    expect(getPairAction({ doc: docOne, selection: sel(docOne, 5) })).toBe("split");
    expect(getPairAction({ doc: docOne, selection: sel(docOne, 1) })).toBeNull();
    expect(getPairAction({ doc: docOne, selection: sel(docOne, size + 1) })).toBeNull();
  });

  it("行 3：跨两个相邻顶层块的选区 → split（直接配对，内容不动）", () => {
    const docTwo = docOf(p("阿里巴巴"), p("2022 - 2025"));
    expect(getPairAction({ doc: docTwo, selection: sel(docTwo, 2, docTwo.content.size - 3) })).toBe(
      "split"
    );
  });

  it("行 3 边界：跨 >2 块或不相邻 → 禁用", () => {
    const docThree = docOf(p("A"), p("B"), p("C"));
    expect(
      getPairAction({ doc: docThree, selection: sel(docThree, 2, docThree.content.size - 2) })
    ).toBeNull();
  });

  it("行 4：光标落在配对行任一列 → merge（toggle 取消配对）", () => {
    const left = p("字节跳动 · 高级前端工程师", { align: "left" });
    const right = p("2021.07 – 2024.12", { align: "right" });
    const docPair = docOf(left, right);
    // 光标在左列
    expect(getPairAction({ doc: docPair, selection: sel(docPair, 3) })).toBe("merge");
    // 光标在右列
    expect(getPairAction({ doc: docPair, selection: sel(docPair, left.nodeSize + 3) })).toBe("merge");
    // 部分选区落在配对列上，同样优先合并（不向下拆）
    expect(
      getPairAction({ doc: docPair, selection: sel(docPair, left.nodeSize + 1, left.nodeSize + 5) })
    ).toBe("merge");
  });

  it("行 4 变体：跨配对行两列的选区 → merge", () => {
    const left = p("公司", { align: "left" });
    const right = p("日期", { align: "right" });
    const docPair = docOf(left, right);
    expect(getPairAction({ doc: docPair, selection: sel(docPair, 2, left.nodeSize + 2) })).toBe(
      "merge"
    );
  });

  it("非配对形态（左列非 left/center）不算配对行 → 正常拆分", () => {
    // align=null + right 不满足 alignPairRow 合并条件，与预览同构
    const docOdd = docOf(p("公司"), p("日期", { align: "right" }));
    expect(getPairAction({ doc: docOdd, selection: sel(docOdd, 2) })).toBe("split");
  });

  it("行 5：嵌套块（列表项内）→ 禁用", () => {
    const item = schema.nodes.listItem.create(null, p("列表里的文字"));
    const list = schema.nodes.bulletList.create(null, item);
    const docList = docOf(list);
    // 光标在 list item 内的段落中（depth=2）
    expect(getPairAction({ doc: docList, selection: sel(docList, 3) })).toBeNull();
  });

  it("标题块与段落同样支持拆分（types 覆盖 heading）", () => {
    const docHeading = docOf(h("模块标题副标题"));
    const sizeH = docHeading.firstChild!.content.size;
    expect(getPairAction({ doc: docHeading, selection: sel(docHeading, sizeH - 2, sizeH + 1) })).toBe(
      "split"
    );
  });
});

// =====================================================================
// 四、命令产物：拆分/合并落成的节点（:::left + :::right 的节点级等价物）
// =====================================================================
describe("命令产物：拆分为 [左列 | 右列]，合并回单段", () => {
  it("行 1 产物：replaceWith 两段，前缀 left、选中 right，后缀顺延", () => {
    const node = p("字节跳动 · 高级前端工程师 2021.07 – 2024.12 附加说明");
    const doc = docOf(node);
    // doc 坐标 = 文本偏移 + 1（单块内容从 pos 1 起）
    const dateFrom = "字节跳动 · 高级前端工程师 ".length + 1;
    const dateTo = dateFrom + "2021.07 – 2024.12".length;
    const { changed, calls } = runCommand("setAlignPair", doc, sel(doc, dateFrom, dateTo));

    expect(changed).toBe(true);
    expect(calls.replaceWith).toHaveLength(1);
    const [from, to, newNodes] = calls.replaceWith[0];
    expect(from).toBe(0);
    expect(to).toBe(node.nodeSize);
    expect(newNodes).toHaveLength(3);
    expect(newNodes.map((n: any) => n.attrs.align)).toEqual(["left", "right", null]);
    expect(newNodes.map((n: any) => n.textContent)).toEqual([
      "字节跳动 · 高级前端工程师",
      "2021.07 – 2024.12",
      "附加说明",
    ]);
  });

  it("行 2 产物：光标处拆为 [光标前 left | 光标后 right]", () => {
    const node = p("字节跳动 · 高级前端工程师 2021.07 – 2024.12");
    const doc = docOf(node);
    // 光标落在接缝空格之后（doc 坐标 = 文本偏移 + 1）
    const at = "字节跳动 · 高级前端工程师 ".length + 1;
    const { changed, calls } = runCommand("setAlignPair", doc, sel(doc, at));

    expect(changed).toBe(true);
    const newNodes = calls.replaceWith[0][2];
    expect(newNodes).toHaveLength(2);
    expect(newNodes.map((n: any) => n.attrs.align)).toEqual(["left", "right"]);
    // 接缝空格不带入列内容
    expect(newNodes[0].textContent).toBe("字节跳动 · 高级前端工程师");
    expect(newNodes[1].textContent).toBe("2021.07 – 2024.12");
  });

  it("行 3 产物：跨两块直接配对（内容不动，仅 setNodeMarkup 两次）", () => {
    const a = p("阿里巴巴");
    const b = p("2022 - 2025");
    const doc = docOf(a, b);
    const { changed, calls } = runCommand("setAlignPair", doc, sel(doc, 2, a.nodeSize + 2));

    expect(changed).toBe(true);
    expect(calls.replaceWith).toHaveLength(0); // 内容不动
    expect(calls.setNodeMarkup).toHaveLength(2);
    expect(calls.setNodeMarkup[0][2].align).toBe("left");
    expect(calls.setNodeMarkup[1][2].align).toBe("right");
  });

  it("行 4 产物：toggle 合并回单段，清对齐，接缝补一个空格", () => {
    const left = p("字节跳动 · 高级前端工程师", { align: "left" });
    const right = p("2021.07 – 2024.12", { align: "right" });
    const doc = docOf(left, right);
    const { changed, calls } = runCommand("toggleAlignPair", doc, sel(doc, 3));

    expect(changed).toBe(true);
    const [from, to, merged] = calls.replaceWith[0];
    expect(from).toBe(0);
    expect(to).toBe(left.nodeSize + right.nodeSize);
    expect(merged.attrs.align).toBeNull();
    expect(merged.textContent).toBe("字节跳动 · 高级前端工程师 2021.07 – 2024.12");
  });

  it("合并接缝：两列边缘已有空白时不再补空格（幂等）", () => {
    const left = p("公司 ", { align: "left" });
    const right = p(" 日期", { align: "right" });
    const doc = docOf(left, right);
    const { changed, calls } = runCommand("toggleAlignPair", doc, sel(doc, 3));

    expect(changed).toBe(true);
    const merged = calls.replaceWith[0][2];
    // 原有空白接缝直接相连（不追加第二个空格）
    expect(merged.textContent).toBe("公司  日期");
  });

  it("toggle 在普通段落上 = 拆分（行为与 setAlignPair 一致）", () => {
    const node = p("AAAA BBBB");
    const doc = docOf(node);
    const r1 = runCommand("toggleAlignPair", doc, sel(doc, 2, 6));
    const r2 = runCommand("setAlignPair", doc, sel(doc, 2, 6));
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);
    expect(r1.calls.replaceWith[0][2].map((n: any) => n.textContent)).toEqual(
      r2.calls.replaceWith[0][2].map((n: any) => n.textContent)
    );
  });

  it("整块选区/行首行尾光标：命令与按钮同为不可用", () => {
    const node = p("ABCD");
    const doc = docOf(node);
    const size = node.content.size;

    expect(runCommand("setAlignPair", doc, sel(doc, 1, size + 1)).changed).toBe(false); // 整块
    expect(runCommand("setAlignPair", doc, sel(doc, 1)).changed).toBe(false); // 行首光标
    expect(runCommand("setAlignPair", doc, sel(doc, size + 1)).changed).toBe(false); // 行尾光标
  });

  it("纯空白选区：修剪后退化为光标拆（[空白前 | 空白后]），不产生空列", () => {
    // 契约补充规则的取舍：按钮可点即命令生效，纯空白选区按接缝拆两列
    const spaced = p("AB  CD");
    const docSpace = docOf(spaced);
    const { changed, calls } = runCommand("setAlignPair", docSpace, sel(docSpace, 3, 5));
    expect(changed).toBe(true);
    const newNodes = calls.replaceWith[0][2];
    expect(newNodes.map((n: any) => n.textContent)).toEqual(["AB", "CD"]);
    expect(newNodes.map((n: any) => n.attrs.align)).toEqual(["left", "right"]);
  });

  it("拆分/合并不触碰 Fragment 之外的结构：标题保留 level", () => {
    const node = h("标题左半右半");
    const doc = docOf(node);
    // 选中「右半」：doc 坐标 [5, 7)（文本偏移 4..6 加 contentStart 1）
    const { changed, calls } = runCommand("setAlignPair", doc, sel(doc, 5, 7));
    expect(changed).toBe(true);
    const newNodes = calls.replaceWith[0][2];
    expect(newNodes).toHaveLength(2);
    expect(newNodes.every((n: any) => n.type.name === "heading")).toBe(true);
    expect(newNodes.every((n: any) => n.attrs.level === 2)).toBe(true);
    expect(newNodes.map((n: any) => n.attrs.align)).toEqual(["left", "right"]);
    expect(newNodes.map((n: any) => n.textContent)).toEqual(["标题左半", "右半"]);
  });
});

// =====================================================================
// 五、产物形态 = 手写 :::left / :::right（与预览合并管线的衔接）
// =====================================================================
describe("产物与手写语法同构：Fragment.cut 两列 = 配对行的左右列", () => {
  it("拆分产物的左右列内容与对齐 = 手写 :::left / :::right 的块内容", () => {
    const node = p("阿里巴巴 2022 - 2025");
    const cut = splitBlockFragments(node, "阿里巴巴 ".length, node.content.size);
    const plan = planPairLayout(!!cut.prefix, !!cut.middle, !!cut.suffix, null);
    expect(plan).toEqual([
      { part: "prefix", align: "left" },
      { part: "middle", align: "right" },
    ]);
    // 手写语法的块内容就是这两段文本；预览 alignPairRow 会把
    // 「align=left 块 + align=right 块」合并为同一行（editor-align-pair.test.ts 钉住）
    expect(fragText(cut.prefix)).toBe("阿里巴巴");
    expect(fragText(cut.middle)).toBe("2022 - 2025");
    // cut 产物是真 Fragment（实例方法可用），可直接喂 node.type.create —— 命令层同款。
    // 不用 Fragment.isFragment：@tiptap/core re-export 的 Fragment 缺静态方法（实测）
    expect(typeof cut.middle?.textBetween).toBe("function");
    expect(cut.middle?.size).toBe("2022 - 2025".length);
  });
});
