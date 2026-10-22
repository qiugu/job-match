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
    expect(dock).not.toContain("handleGrammarCheck");
    expect(dock).not.toContain("toggleEditPanel");
    expect(dock).not.toContain("SpellCheck2");
    expect(dock).not.toContain("autoOnePage");
    expect(dock).not.toContain("<Edit2");
    expect(dock).not.toContain("{/* <DockIcon>");
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
    expect(markdownWorkbench).toContain("previewPanelRef.current?.expand(50)");

    expect(workbench).toContain(
      "setPreviewPanelCollapsed((collapsed) => !collapsed)"
    );
  });
});

describe("one-page feature removal", () => {
  it("removes the broken one-page toggle from the desktop workbench", () => {
    const markdownWorkbench = source(
      "src/components/editor/MarkdownWorkbench.tsx"
    );

    expect(markdownWorkbench).not.toContain("autoOnePage");
    expect(markdownWorkbench).not.toContain("一页纸");
  });

  it("removes the dead one-page wiring from preview, types, i18n and hooks", () => {
    expect(source("src/components/preview/index.tsx")).not.toContain(
      "autoOnePage"
    );
    expect(source("src/components/preview/index.tsx")).not.toContain(
      "useAutoOnePage"
    );
    expect(source("src/types/resume.ts")).not.toContain("autoOnePage");
    expect(source("src/i18n/locales/zh.json")).not.toContain("autoOnePage");
    expect(source("src/i18n/locales/en.json")).not.toContain("autoOnePage");
    // useAutoOnePage hook 文件应已删除
    expect(() => source("src/hooks/useAutoOnePage.ts")).toThrow();
  });
});
