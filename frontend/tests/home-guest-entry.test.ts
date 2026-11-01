/**
 * 落地页游客入口回归测试（2026-10-31）：
 *
 * 背景：CTASection 的「免登录，先试试编辑器」按钮曾被写成 type="button"，
 * 而 GoTryEditor 依赖 <form onSubmit> 跳转——type="button" 不触发表单提交，
 * 按钮自上线起完全无法点击；同时首页首屏主 CTA 指向登录墙，
 * 游客唯一入口被埋在页底（用户反馈「按钮隐藏的这么深，并且无法点击」）。
 *
 * 锁定三条不变量：
 *   1. CTASection 的游客按钮必须是 type="submit"（GoTryEditor 的 form 才会触发）；
 *   2. HeroSection 首屏主 CTA 走 GoTryEditor（/edit），而非 GoDashboard 登录墙；
 *   3. hero.cta 文案 zh/en 双写且 en 无中文残留。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

/** CJK 统一表意文字——英文语言包文案不应出现 */
const CJK_RE = /[一-鿿㐀-䶿]/;

describe("落地页游客入口", () => {
  it("CTASection 游客按钮必须是 type=submit（防死按钮回归）", () => {
    const src = source("src/components/home/CTASection.tsx");

    // GoTryEditor 的 children 按钮必须可提交表单
    const block = src.slice(src.indexOf("<GoTryEditor>"), src.indexOf("</GoTryEditor>"));
    expect(block).toContain('type="submit"');
    expect(block).not.toContain('type="button"');
  });

  it("HeroSection 首屏主 CTA 指向游客编辑器而非登录墙", () => {
    const src = source("src/components/home/HeroSection.tsx");

    // hero.cta 包裹在 GoTryEditor（→ /edit）里
    const heroBlock = src.slice(
      src.indexOf("{t(\"hero.cta\")}") - 400,
      src.indexOf("{t(\"hero.cta\")}")
    );
    expect(heroBlock).toContain("<GoTryEditor>");
    // 次按钮（我的简历）保留登录墙语义
    expect(src).toContain('<GoDashboard type="resumes">');
  });

  it("hero.cta 文案 zh/en 双写且 en 无中文残留", () => {
    const zh = JSON.parse(source("src/i18n/locales/zh.json")) as {
      home: { hero: { cta: string } };
    };
    const en = JSON.parse(source("src/i18n/locales/en.json")) as {
      home: { hero: { cta: string } };
    };

    expect(typeof zh.home.hero.cta).toBe("string");
    expect(zh.home.hero.cta.length).toBeGreaterThan(0);
    expect(typeof en.home.hero.cta).toBe("string");
    expect(en.home.hero.cta.length).toBeGreaterThan(0);
    expect(CJK_RE.test(en.home.hero.cta)).toBe(false);
  });
});
