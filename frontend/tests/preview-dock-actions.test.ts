import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("workbench floating dock actions", () => {
  it("keeps only the currently visible desktop dock actions", () => {
    const dock = source("src/components/preview/PreviewDock.tsx");

    expect(dock).toContain("<TemplateSheet");
    expect(dock).toContain("<PdfExport>");
    expect(dock).toContain("onClick={togglePreviewPanel}");
    expect(dock).toContain("onClick={handleCopyResume}");
    expect(dock).toContain('router.push("/app/dashboard")');
    expect(dock.match(/<button\b/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    // 校对入口**回到** Dock（2026-10-28 依据用户反馈改判）：
    // 校对作用于「预览里的正文」，与模板/导出/复制同属一类操作；
    // 曾一度上提到 EditorHeader，结果是顶部多出一个与「保存」抢权重的按钮，
    // 且入口与抽屉分居两个组件。现在入口与抽屉都由 Dock 承载。
    expect(dock).toContain("SpellCheck2");
    expect(dock).toContain("data-dock-proofread");
    expect(dock).toContain("<GrammarCheckDrawer />");
    // 翻译简历入口（PLAN_resume_translate.md）：与模板/导出/复制同属
    // 「操作简历正文」一类，落在第一组；对话框由 Dock 托管（同宿主）。
    expect(dock).toContain("Languages");
    expect(dock).toContain("data-dock-translate");
    expect(dock).toContain("<TranslateDialog");
    expect(dock).not.toContain("toggleEditPanel");
    expect(dock).not.toContain("autoOnePage");
    expect(dock).not.toContain("<Edit2");
    expect(dock).not.toContain("{/* <DockIcon>");
  });

  it("keeps the proofread trigger out of the top editor header", () => {
    const header = source("src/components/editor/EditorHeader.tsx");

    // 顶部工具行只保留「撤销/重做 · 主题 · 保存 · 导出」，不再派发抽屉事件，
    // 也不内联渲染抽屉——避免同一能力出现两个入口。
    expect(header).not.toContain("open-grammar-drawer");
    expect(header).not.toContain("GrammarCheckDrawer");
    expect(header).not.toContain("SpellCheck2");
  });

  it("connects the visible preview dock action to the markdown workbench", () => {
    const workbench = source("src/app/app/workbench/[id]/page.tsx");

    expect(workbench).toContain(
      "previewPanelCollapsed={previewPanelCollapsed}"
    );
    expect(workbench).toContain("resumeContentRef={resumeContentRef}");
  });

  it("binds the dock panel states to the rendered markdown workbench", () => {
    const workbench = source("src/app/app/workbench/[id]/page.tsx");
    const markdownWorkbench = source(
      "src/components/editor/MarkdownWorkbench.tsx"
    );

    expect(markdownWorkbench).toContain("previewPanelCollapsed");
    expect(markdownWorkbench).toContain("resumeContentRef");
    expect(markdownWorkbench).not.toContain("editorPanelCollapsed");
    expect(markdownWorkbench).toContain("ImperativePanelHandle");
    expect(markdownWorkbench).toContain("previewPanelRef");
    expect(markdownWorkbench).toContain("collapsible");
    expect(markdownWorkbench).toContain("collapsedSize={0}");
    expect(markdownWorkbench).toContain(
      "previewPanelRef.current?.collapse()"
    );
    // expand() 不传尺寸：恢复到 collapse 前宽度（传 50 会把窄自定义宽度顶回 50%）
    expect(markdownWorkbench).toContain(
      "previewPanelRef.current?.expand();"
    );
    // 竞态修复：面板挂载（activeResume 就绪）后必须同步当前折叠态
    expect(markdownWorkbench).toContain("const resumeReady = !!activeResume;");
    expect(markdownWorkbench).toContain(
      "[previewPanelCollapsed, resumeReady]"
    );

    expect(workbench).toContain(
      "setPreviewPanelCollapsed((collapsed) => !collapsed)"
    );
  });
});
