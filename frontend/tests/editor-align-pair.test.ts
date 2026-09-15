import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMarkdownToHtml } from "@/utils/markdownRender";

/**
 * 「同一行内左右分布」（配对排版）的往返契约（2026-09-11）。
 *
 * 背景：内置 `modern` 模板用紧凑单行配对表达「左信息 | 右信息」：
 *   :::left 138-0013-8000 · zhangsan@example.com ::: :::right 北京市朝阳区 :::
 * 预览侧支持它（渲染为 <p.md-align-inline-pair> 双 span + flex），但 Tiptap 的
 * 文档模型里**没有**「同行左右分列」的节点，该写法在编辑器中被压平：
 * 容器与两侧对齐全丢，两段文字无分隔符粘连。
 *
 * 修复方式（方案 C）：解析期把配对段落拆成两个各自带 align 的段落，序列化时
 * 输出为 `:::left` 块 + `:::right` 块，由预览侧的 alignPairRow 规则**重新合并
 * 为同一行**。两条渲染路径等价 —— 这正是本文件要钉住的不变量。
 *
 * 分层：编辑器侧（DOM 相关）由 `frontend/scripts/editor-probe/` 在真实 Chromium
 * 中验证（本项目 vitest 是 node 环境，无 jsdom）；本文件负责 node 可验证的部分
 * —— 预览渲染契约（纯函数）与源码级契约。
 */

/** 编辑器序列化器的真实输出形态：块间**无空行**，块内尾部多一空行 */
const SERIALIZED_PAIR =
  ":::left\n138-0013-8000 · zhangsan@example.com\n\n:::\n:::right\n北京市朝阳区\n\n:::";

describe("预览侧：两种配对写法的渲染等价性", () => {
  it("编辑器序列化产物（块形式）仍被合并为同一行，往返不破坏版面", () => {
    const html = renderMarkdownToHtml(SERIALIZED_PAIR);

    // 必须合并成一行 —— 否则修复会让「同行左右」退化成上下两段
    expect(html).toContain("md-pair-row");
    expect(html).toContain("md-align-left");
    expect(html).toContain("md-align-right");
    // 左右内容都在，且顺序正确（左在前、右在后）
    expect(html.indexOf("zhangsan@example.com")).toBeLessThan(html.indexOf("北京市朝阳区"));
  });

  it("块间无空行（::: 紧接着 :::right）也能配对，不依赖空行分隔", () => {
    // 这是序列化器的实际输出，若预览要求空行分隔，往返就会断裂
    const html = renderMarkdownToHtml(SERIALIZED_PAIR);
    expect(html).toContain("md-pair-row");
    expect(html).not.toContain(":::");
  });

  it("存量紧凑写法（:::left A ::: :::right B :::）仍受支持 —— 向后兼容旧数据", () => {
    const html = renderMarkdownToHtml(":::left A ::: :::right B :::");
    expect(html).toContain("md-align-inline-pair");
    expect(html).toContain('class="md-align-left"');
    expect(html).toContain('class="md-align-right"');
  });

  it("单段内联（无配对）渲染为单容器，不被误当配对行", () => {
    const html = renderMarkdownToHtml(":::left 138-0013-8000 :::");
    expect(html).toContain("md-align-left");
    expect(html).not.toContain("md-pair-row");
  });
});

describe("源码契约：解析期必须拆分配对段落，不得再压平", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../src/components/editor/extensions/align.ts", import.meta.url)
    ),
    "utf8"
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("多段分支会调用拆分逻辑", () => {
    expect(source).toMatch(/splitInlineAlignPair\(paragraph\)/);
  });

  it("不再存在「兄弟 span 数不为 1 就直接 return」的旧写法", () => {
    // 旧实现：siblings.length !== 1 时 return —— 结果是多段 span 被
    // ProseMirror 压平、文本粘连（本文件修复前的真实缺陷）
    expect(source).not.toMatch(/siblings\.length\s*!==\s*1/);
  });

  it("拆分时搬运 span 的子节点（保留 strong/em/a 等行内标记），而非只取文本", () => {
    expect(source).toMatch(/while \(span\.firstChild\) block\.appendChild\(span\.firstChild\)/);
    // 反向约束：不得用 textContent 重建，那会丢掉行内标记
    expect(source).not.toMatch(/block\.textContent\s*=/);
  });

  it("拆分前会检查段落中是否混有其它内容，避免静默丢弃用户内容", () => {
    expect(source).toMatch(/hasOtherInlineContent\(paragraph\)/);
  });

  it("按段落去重后处理，避免同一段落被多个 span 重复命中", () => {
    expect(source).toMatch(/seenParents\.has\(p\)/);
    expect(source).toMatch(/seenParents\.add\(p\)/);
  });

  it("先校验齐备再改动 DOM（避免改到一半把内容留在被移除的原段落里）", () => {
    // 校验循环必须在创建/插入 block 之前
    const validateAt = source.indexOf("for (const span of spans)");
    const mutateAt = source.indexOf("spans.forEach((span: any, index: number)");
    expect(validateAt).toBeGreaterThan(-1);
    expect(mutateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(mutateAt);
  });
});
