import { describe, expect, it } from "vitest";
import { buildPrintHtml } from "@/utils/printHtml";

/**
 * buildPrintHtml 组装层测试：浏览器打印（print.ts）与服务端 PDF 导出
 * （pdfExportServer.ts）共用同一份打印版 HTML，关键不变量：
 * - @page A4 + margin 0（边距交由 #resume-preview padding 表达，与预览一致）；
 * - pagePadding 落到 #resume-preview 的 padding；
 * - @font-face（字体 css）与文档样式、分页 CSS 均内联，HTML 自包含；
 * - 内容（含用户文本）不会被 <title> 插值破坏（escapeHtml）。
 */
describe("buildPrintHtml 打印版 HTML 组装", () => {
  const base = {
    content: "<h1>张三</h1><p>前端工程师</p>",
    pagePadding: 48,
    fontFamily: '"Noto Sans SC", sans-serif',
  };

  it("注入 @page A4 + margin 0", () => {
    const html = buildPrintHtml(base);
    expect(html).toContain("@page {");
    expect(html).toContain("size: A4;");
    expect(html).toContain("margin: 0;");
  });

  it("pagePadding 落到 #resume-preview padding", () => {
    const html = buildPrintHtml({ ...base, pagePadding: 48 });
    expect(html).toContain("padding: 48px !important;");
  });

  it("字体 css / 分页 CSS / 文档样式均内联", () => {
    const html = buildPrintHtml({
      ...base,
      fontFaceCss: "@font-face { font-family: 'Noto Sans SC'; }",
      contentCss: ".resume-title { color: #333; }",
    });
    expect(html).toContain("@font-face");
    expect(html).toContain("#resume-preview p"); // PAGE_BREAK_CSS 内联
    expect(html).toContain(".resume-title");
  });

  it("title 中特殊字符被转义，不破坏 HTML 结构", () => {
    const html = buildPrintHtml({ ...base, title: 'A&B <"怪"> 名.pdf' });
    expect(html).toContain("<title>A&amp;B &lt;");
    expect(html).not.toContain('A&B <"怪"> 名.pdf</title>');
  });

  it("内容按原样嵌入 #print-content", () => {
    const html = buildPrintHtml(base);
    expect(html).toContain('<div id="print-content">');
    expect(html).toContain("<h1>张三</h1>");
  });
});
