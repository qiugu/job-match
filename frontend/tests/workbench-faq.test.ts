import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("workbench FAQ content", () => {
  it("covers the current editor workflow", () => {
    const faqConfig = source("src/config/faq.tsx");
    const zh = source("src/i18n/locales/zh.json");
    const en = source("src/i18n/locales/en.json");

    expect(faqConfig).toContain('"markdown-editor"');
    expect(faqConfig).toContain('"preview-panel"');
    expect(faqConfig).toContain('"pdf-export"');
    expect(faqConfig).toContain('"resume-management"');

    expect(zh).toContain("Markdown 编辑器");
    expect(zh).toContain("实时预览");
    expect(zh).toContain("模板");
    expect(zh).not.toContain("拖拽调整模块顺序");

    expect(en).toContain("Markdown editor");
    expect(en).toContain("live preview");
    expect(en).toContain("template");
    expect(en).not.toContain("drag and drop to reorder modules");
  });
});
