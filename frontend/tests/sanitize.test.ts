import { describe, it, expect } from "vitest";
import { sanitizeResumeHtml } from "@/lib/sanitize";
import { renderMarkdownToHtml } from "@/utils/markdownRender";
import { normalizeRichTextContent } from "@/lib/richText";

describe("sanitizeResumeHtml (S1/S2 白名单清洗)", () => {
  it("剥离 <script>", () => {
    const out = sanitizeResumeHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>hi</p>");
  });

  it("剥离 on* 事件处理器", () => {
    const out = sanitizeResumeHtml('<img src=x onerror=alert(1)><div onclick="x()">a</div>');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
  });

  it("剥离 javascript: 协议链接", () => {
    const out = sanitizeResumeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("剥离危险的 <iframe> / <object>", () => {
    const out = sanitizeResumeHtml('<iframe src="//evil"></iframe><object data="x"></object>');
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
  });

  it("保留安全标签与 https 链接", () => {
    const out = sanitizeResumeHtml(
      "<p><strong>bold</strong> <a href='https://e.com' target='_blank'>l</a></p><ul><li>a</li></ul>"
    );
    expect(out).toContain("<strong>");
    expect(out).toContain('href="https://e.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>");
  });

  it("规范化协议相对 / 裸域名链接（S2 normalizeLinkHref）", () => {
    // normalizeLinkHref 在 richText.ts 的 normalizeRichTextContent 路径中生效，
    // sanitizeResumeHtml 仅做白名单清洗、不负责协议规范化。
    expect(normalizeRichTextContent('<a href="//e.com">x</a>')).toContain('href="https://e.com"');
    expect(normalizeRichTextContent('<a href="e.com">x</a>')).toContain('href="https://e.com"');
  });
});

describe("renderMarkdownToHtml XSS (S1)", () => {
  it("中和内联 <script>", () => {
    const out = renderMarkdownToHtml("hello\n\n<script>alert(1)</script>");
    expect(out).not.toContain("<script");
  });

  it("中和 img onerror", () => {
    const out = renderMarkdownToHtml('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("保留正常列表渲染（html:true 语义不丢）", () => {
    const out = renderMarkdownToHtml("- a\n- b");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>");
  });
});

describe("normalizeRichTextContent XSS (S2)", () => {
  it("剥离富文本中的 <script>", () => {
    const out = normalizeRichTextContent("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
  });

  it("丢弃 javascript: 链接", () => {
    const out = normalizeRichTextContent('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a");
  });

  it("纯文本正常转义并换行", () => {
    const out = normalizeRichTextContent("line1\nline2");
    expect(out).toContain("<br");
    expect(out).not.toContain("<script");
  });
});
