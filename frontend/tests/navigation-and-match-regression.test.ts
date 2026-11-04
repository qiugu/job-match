import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("dashboard regression guard", () => {
  it("keeps delivery and matching observability under one analytics route", () => {
    const sidebar = source("src/app/app/dashboard/client.tsx");
    const analytics = source("src/app/app/dashboard/analytics/page.tsx");

    expect(sidebar).toContain('url: "/app/dashboard/analytics"');
    expect(analytics).toContain('"delivery"');
    expect(analytics).toContain('"matching"');
    expect(analytics).toContain("<MatchingObservability");
  });

  it("labels the account balance as credits", () => {
    const zh = JSON.parse(source("src/i18n/locales/zh.json"));
    expect(zh.auth.quota).toBe("剩余积分");
    expect(zh.auth.quotaUnlimited).toBe("积分不限");
  });

  it("does not present the primary action as ready without a JD or images", () => {
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    // 纯截图 JD 允许提交，因此禁用条件必须同时考虑文本与图片。
    expect(matchPage).toContain("(!jdText.trim() && jdImages.length === 0)");
    expect(matchPage).toContain("!selected");
  });

  it("keeps the primary CTA on the Paper & Punch button primitive", () => {
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    const css = source("src/app/globals.css");
    // 钴蓝实心由 .pp-btn 提供；--punch 显式补回 4px 硬偏移阴影，
    // 因为工作台 calm 密度会把 --shadow-card 覆写成 none。
    expect(matchPage).toContain('className="pp-btn pp-btn--punch group w-full text-sm"');
    expect(css).toContain(".pp-btn.pp-btn--punch:not(:disabled)");
    expect(css).toContain("box-shadow: 4px 4px 0 var(--shadow-color)");
  });

  it("uses numbered section labels instead of flat stacked cards", () => {
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    const modePicker = source("src/components/match/TaskModePicker.tsx");
    expect(modePicker).toContain('<SectionLabel no="01"');
    expect(matchPage).toContain('<SectionLabel no="02"');
    expect(matchPage).toContain('<SectionLabel no="03"');
    expect(matchPage).toContain('<SectionLabel no="04"');
    // 中文小标签禁 mono + uppercase + 字距，否则汉字被拉散。
    expect(modePicker).not.toContain("uppercase tracking-wider");
    expect(modePicker).not.toContain("font-mono");
  });

  it("embeds JD screenshots as chat-composer attachments", () => {
    const uploader = source("src/components/match/JdImageUploader.tsx");
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    const css = source("src/app/globals.css");
    // 输入框与附件共用一个容器：Textarea 由页面作为 children 传入且自身无边框。
    expect(uploader).toContain("children: ReactNode");
    expect(uploader).toContain("{children}");
    expect(matchPage).toContain("<JdImageUploader");
    expect(matchPage).toContain("border-0 bg-transparent");
    expect(matchPage).not.toContain(
      'className="min-h-[120px] resize-y rounded-lg border border-line-strong'
    );
    // 单一容器：只有 focus-within / 拖放态才出钴蓝；常驻虚线上传盒已删除。
    expect(uploader).toContain("focus-within:border-cobalt");
    expect(uploader).not.toContain(
      '"rounded-lg border border-dashed px-3 py-2 transition-colors"'
    );
    expect(uploader).toContain("dragActive && (");
    // 说明文案不再常驻成一行 <p>；改为工具条 tooltip + 容器 aria-label。
    expect(uploader).not.toContain("images.length === 0 && (");
    // 附件 chip 有入场动效且尊重 reduced-motion。
    expect(uploader).toContain("jd-chip-in");
    expect(css).toContain("@keyframes jdChipIn");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("uses the Chinese label primitive instead of uppercase tracking", () => {
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    const sectionLabel = source("src/components/match/SectionLabel.tsx");
    // 中文小标签已统一收敛到 SectionLabel 内的 .eb-zh，不再散落在各页面。
    expect(matchPage).toContain("<SectionLabel");
    expect(sectionLabel).toContain("eb-zh");
    expect(sectionLabel).not.toContain("uppercase");
    expect(sectionLabel).not.toContain("tracking-wider");
    expect(matchPage).not.toContain("uppercase tracking-wider");
  });

  it("keeps JD screenshots when resuming a pitch into a match", () => {
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    // 话术结果区「生成定制简历」必须传 undefined：传 jdText 会被当成外部 JD
    // 回填，误清空本次上传的截图（纯截图 JD 会直接失效）。
    expect(matchPage).toContain('handleCreate(undefined, "match")');
    expect(matchPage).not.toContain('handleCreate(jdText, "match")');
    expect(matchPage).toContain("jdOverride !== undefined");
  });

  it("derives cobalt CTA text color from the paper token", () => {
    const css = source("src/app/globals.css");
    // 深色下钴蓝提亮为 #7C86FF，硬编码白字仅约 3:1 不达 WCAG AA。
    expect(css).toContain("color: var(--paper);");
    expect(css).not.toContain("color: #ffffff;");
  });
});
