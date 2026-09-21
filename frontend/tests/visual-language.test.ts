import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workbench visual language", () => {
  it("defines one shared surface vocabulary", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".workbench-page");
    expect(css).toContain(".workbench-panel");
    expect(css).toContain(".workbench-header");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
