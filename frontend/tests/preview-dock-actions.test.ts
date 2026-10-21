import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("workbench floating dock actions", () => {
  it("renders every desktop dock action as an explicit button", () => {
    const dock = source("src/components/preview/PreviewDock.tsx");

    expect(dock).toContain("onClick={handleGrammarCheck}");
    expect(dock).toContain("onClick={toggleSidePanel}");
    expect(dock).toContain("onClick={toggleEditPanel}");
    expect(dock).toContain("onClick={togglePreviewPanel}");
    expect(dock).toContain("onClick={handleCopyResume}");
    expect(dock).toContain('router.push("/app/dashboard")');
    expect(dock).toContain("autoOnePage: !globalSettings?.autoOnePage");
    expect(dock.match(/<button\b/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(dock).not.toContain("{/* <DockIcon>");
  });

  it("connects the preview content ref used by the grammar action", () => {
    const workbench = source("src/app/app/workbench/[id]/page.tsx");

    expect(workbench).toContain("ref={resumeContentRef}");
  });
});
