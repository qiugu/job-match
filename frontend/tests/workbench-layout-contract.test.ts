import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * 工作台三栏布局的源码级契约（2026-10-28 一次五连修的回归护栏）。
 *
 * 这些约束此前以「肉眼对齐」的方式维护，一旦有人把常量改回硬编码百分比或
 * 给某一栏另起一套头部高度，就会重新退化成「参差不齐」。用源码断言把口径
 * 钉住，比截图比对便宜得多，也更能说明「为什么这样写」。
 */
describe("markdown workbench layout contract", () => {
  const workbench = source("src/components/editor/MarkdownWorkbench.tsx");
  const editor = source("src/components/editor/MarkdownEditor.tsx");
  const preview = source("src/components/preview/MarkdownPreview.tsx");
  const header = source("src/components/editor/EditorHeader.tsx");
  const drawer = source(
    "src/components/editor/grammar/GrammarCheckDrawer.tsx"
  );
  const linkedScroll = source("src/hooks/useLinkedScroll.ts");

  it("sizes the typeset column in pixels and lets it collapse to a rail", () => {
    // 按像素定档：排版设置是固定密度的控件列，宽度与视口无关
    expect(workbench).toContain("defaultPx: 224");
    // 收起态只能写百分比：react-resizable-panels 挂载后不再读取 collapsedSize，
    // 按容器宽度折算会把窄轨钉死在首帧的换算结果上。2.5% 在 1600 视口正好 40px。
    expect(workbench).toContain("const TYPESET_RAIL_PCT = 2.5;");
    expect(workbench).toContain("collapsedSize={TYPESET_RAIL_PCT}");
    // 收起状态跨会话保留，且初值直接取自 localStorage（不在 effect 里 setState）
    expect(workbench).toContain("TYPESET_COLLAPSED_KEY");
    expect(workbench).toContain("useState(readTypesetCollapsed)");
  });

  it("keeps the typeset column at a fixed pixel width across viewport changes", () => {
    // 容器宽度观察器必须走 ref callback：activeResume 就绪前组件整体 return null，
    // 用 useEffect([]) 挂观察器只会拿到空 ref 且永不重跑 —— groupWidth 恒为 0，
    // 像素折算全部走兜底值，左栏重新变成随视口缩放的百分比（1920 屏 268px）。
    expect(workbench).toContain("const attachGroupWrap = useCallback");
    expect(workbench).toContain("ref={attachGroupWrap}");
    expect(workbench).not.toContain("groupWrapRef.current");
    // 宽度或档位变化后重新折合百分比并 resize 回去
    expect(workbench).toContain("typesetPanelRef.current?.resize(pxToPct(");
    // 拖拽越界要夹回 200–360px（minSize/maxSize 只接受百分比，夹不住像素）
    expect(workbench).toContain("TYPESET_PANEL.minPx");
    expect(workbench).toContain("TYPESET_PANEL.maxPx");
  });

  it("derives all three panel percentages so they sum to 100", () => {
    // react-resizable-panels 会归一化 defaultSize：左栏按像素定档后，
    // 编辑/预览必须按剩余空间比例分配，否则像素口径会被静默放大。
    expect(workbench).toContain("const restPct = 100 - typesetPct;");
    expect(workbench).toContain("const editorPct = restPct * 0.4;");
    expect(workbench).toContain("const previewPct = restPct * 0.6;");
    expect(workbench).toContain("defaultSize={editorPct}");
    expect(workbench).toContain("defaultSize={previewPct}");
    expect(workbench).not.toContain("defaultSize={32}");
    expect(workbench).not.toContain("defaultSize={48}");
  });

  it("keeps the three panel bars on one baseline", () => {
    // 唯一高度口径：三栏头部必须共用同一个常量
    expect(workbench).toContain('const PANEL_BAR_HEIGHT = "h-[42px]"');
    expect(workbench).toContain("PANEL_BAR_HEIGHT,");
    // 编辑栏的头部就是富文本工具条本身，不得另起一条标题栏
    expect(editor).toContain('h-[42px]');
    expect(editor).toContain('data-bar="editor"');
    // 编辑栏不再出现独立的「Markdown 编辑」标题行
    expect(workbench).not.toContain('data-bar="editor"');
  });

  it("links editor and preview scrolling in both directions", () => {
    expect(workbench).toContain("useLinkedScroll(");
    expect(workbench).toContain("!previewPanelCollapsed");
    // 两侧都必须把内部滚动容器暴露出来
    expect(editor).toContain("onScrollContainer");
    expect(editor).toContain('data-sync-scroll="editor"');
    expect(preview).toContain("onScrollContainer");
    expect(preview).toContain('data-sync-scroll="preview"');
    // 按比例映射 + 回环锁
    expect(linkedScroll).toContain("LOCK_RELEASE_MS");
    expect(linkedScroll).toContain("sourceMax");
    expect(linkedScroll).toContain("lockedElRef");
  });

  it("keeps every top-bar control at one height", () => {
    // 顶部工具行统一 36px；不允许再出现 h-8 / size="icon"(40px) 混排
    expect(header).toContain('const CTRL_H = "h-9"');
    expect(header).toContain("CTRL_ICON");
    expect(header).toContain("CTRL_PRIMARY");
    expect(header).not.toContain("h-8 w-8");
    expect(header).not.toContain('size="icon"');
  });

  it("renders the proofread drawer above the floating dock and below the header", () => {
    // 层级：高于 PreviewDock 的 z-[50]，否则浮条会压在抽屉边上
    expect(drawer).toContain("z-[70]");
    // 不透明底色：半透明会让底下的排版设置整片透出来，读起来像「被遮挡」
    expect(drawer).not.toContain("bg-muted/30");
    expect(drawer).toContain("bg-paper-2");
    // 让出 64px 顶部工具行：抽屉是非模态检查器，保存/导出仍应可点
    expect(drawer).toContain("top-16");
    // cva 内置的 sm:max-w-sm(384px) 会吃掉 450px 宽度，必须显式放宽
    expect(drawer).toContain("sm:max-w-[450px]");
  });
});
