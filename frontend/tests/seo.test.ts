/**
 * SEO 基建回归测试（2026-09-10 技术 SEO 优化）：
 *
 * 此前三个 P0 问题均源于「基址 / 结构化数据分散硬编码且读 http」：
 *   1. canonical 全站指向 http://jdmatch.site（生产已是 HTTPS），被判重复内容；
 *   2. OG 图指向 /web-shot.png（实际是 .jpg），分享预览全空；
 *   3. 全站零结构化数据，无 hreflang 互指。
 *
 * 本文件锁定 src/lib/seo/site.ts 与 src/lib/seo/jsonld.ts 的契约，确保：
 *   - 基址恒为 https（构建期 VITE_SITE_URL 缺省回退到 https）；
 *   - canonical / hreflang / OG 全部源自同一收敛模块，不再漂移；
 *   - 四类结构化数据（Organization / WebSite / SoftwareApplication / FAQPage）
 *     经 @graph 合并，且 FAQ 空答案被过滤，序列化时转义 `<` 防提前闭合。
 *
 * 注意：site.ts 读取 import.meta.env.VITE_SITE_URL；vitest 下该值为 undefined，
 * 因此 SITE_URL 走 DEFAULT_SITE_URL 回退，测试断言也基于该回退值。
 */
import { describe, expect, it } from "vitest";
import {
  DISALLOWED_PATHS,
  DEFAULT_SITE_URL,
  OG_IMAGE_PATH,
  SITE_URL,
  absoluteUrl,
  alternateLinksFor,
  canonicalFor,
  indexablePaths,
  ogLocaleFor,
  resolveSiteUrl,
} from "@/lib/seo/site";
import {
  buildFaqPageJsonLd,
  buildLandingJsonLdDocument,
  serializeJsonLd,
  type FaqEntry,
} from "@/lib/seo/jsonld";

describe("resolveSiteUrl", () => {
  it("默认回退到 https 基址（而非历史遗留的 http）", () => {
    expect(resolveSiteUrl(undefined)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl(null)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl("")).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl("   ")).toBe(DEFAULT_SITE_URL);
  });

  it("去除尾斜杠", () => {
    expect(resolveSiteUrl("https://example.com/")).toBe("https://example.com");
    expect(resolveSiteUrl("https://example.com///")).toBe("https://example.com");
  });

  it("拒绝非 http(s) 的畸形值并回退", () => {
    expect(resolveSiteUrl("ftp://example.com")).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl("//example.com")).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl("not-a-url")).toBe(DEFAULT_SITE_URL);
  });

  it("接受合法的 https / http 地址", () => {
    expect(resolveSiteUrl("https://jdmatch.site")).toBe("https://jdmatch.site");
    expect(resolveSiteUrl("http://localhost:3005")).toBe("http://localhost:3005");
  });
});

describe("SITE_URL 收敛", () => {
  it("vitest 下 VITE_SITE_URL 未注入，回退到 https 默认基址", () => {
    expect(SITE_URL).toBe(DEFAULT_SITE_URL);
    expect(SITE_URL).toMatch(/^https:\/\//);
    expect(SITE_URL).not.toMatch(/^http:\/\/(?!localhost)/);
  });

  it("canonical 始终为 https 且无尾斜杠", () => {
    expect(canonicalFor("zh")).toBe("https://jdmatch.site/zh");
    expect(canonicalFor("en")).toBe("https://jdmatch.site/en");
  });
});

describe("alternateLinksFor（hreflang 互指）", () => {
  it("本语言 + 另一语言 + x-default 三者齐备", () => {
    const links = alternateLinksFor("zh");
    const hrefLangs = links.map((l) => l.hrefLang).sort();
    expect(hrefLangs).toEqual(["en", "x-default", "zh"]);
  });

  it("每个 hreflang 都指向一个合法的 https canonical", () => {
    for (const link of alternateLinksFor("en")) {
      expect(link.href).toMatch(/^https:\/\/jdmatch.site\/(zh|en)$/);
    }
    // x-default 必须落到默认语言（zh）
    const xdefault = alternateLinksFor("en").find((l) => l.hrefLang === "x-default");
    expect(xdefault?.href).toBe("https://jdmatch.site/zh");
  });

  it("en 与 zh 互为 alternate，且各自包含对方", () => {
    const zhHrefs = alternateLinksFor("zh").map((l) => l.href);
    const enHrefs = alternateLinksFor("en").map((l) => l.href);
    expect(zhHrefs).toContain("https://jdmatch.site/en");
    expect(enHrefs).toContain("https://jdmatch.site/zh");
  });
});

describe("ogLocaleFor", () => {
  it("映射为 territory 形式（zh→zh_CN, en→en_US）", () => {
    expect(ogLocaleFor("zh")).toBe("zh_CN");
    expect(ogLocaleFor("en")).toBe("en_US");
  });
});

describe("absoluteUrl", () => {
  it("绝对地址原样返回", () => {
    expect(absoluteUrl("https://x.com/a")).toBe("https://x.com/a");
  });
  it("相对路径拼接基址并补前导斜杠", () => {
    expect(absoluteUrl("/og-image.png")).toBe("https://jdmatch.site/og-image.png");
    expect(absoluteUrl("og-image.png")).toBe("https://jdmatch.site/og-image.png");
  });
});

describe("OG 图与可索引路径", () => {
  it("OG 图指向真实存在的 png（修复历史 .png→.jpg 404）", () => {
    expect(OG_IMAGE_PATH).toBe("/og-image.png");
  });

  it("indexablePaths 仅包含语言落地页，按默认语言优先级更高", () => {
    const paths = indexablePaths();
    expect(paths).toHaveLength(2);
    const zh = paths.find((p) => p.locale === "zh")!;
    const en = paths.find((p) => p.locale === "en")!;
    expect(zh.priority).toBe("1.0");
    expect(en.priority).toBe("0.9");
  });

  it("DISALLOWED_PATHS 覆盖登录态页面与代理接口", () => {
    expect(DISALLOWED_PATHS).toContain("/app/");
    expect(DISALLOWED_PATHS).toContain("/api/");
    expect(DISALLOWED_PATHS).toContain("/image-proxy");
  });
});

describe("JSON-LD 结构化数据", () => {
  const faq: FaqEntry[] = [
    { question: "如何注册？", answer: "注册开放，无需注册码，使用用户名与密码即可注册并登录。" },
    { question: "是否免费？", answer: "注册即赠 50 试用积分；注册码为可选，仅在新账号注册时充入，不能补充已有账号。" },
    { question: "", answer: "空问题应被过滤" },
    { question: "空答案", answer: "" },
  ];

  it("buildLandingJsonLdDocument 合并四类 schema 到 @graph", () => {
    const doc = buildLandingJsonLdDocument({
      locale: "zh",
      description: "desc",
      faq,
    });
    expect(doc["@context"]).toBe("https://schema.org");
    const types = (doc["@graph"] as Array<{ "@type": string }>).map((n) => n["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
    // FAQ 有内容条目时才出现
    expect(types).toContain("FAQPage");
  });

  it("FAQPage 过滤空问题 / 空答案，仅保留 2 条有效问答", () => {
    const faqJson = buildFaqPageJsonLd(faq);
    const entities = (faqJson.mainEntity as unknown[]).length;
    expect(entities).toBe(2);
  });

  it("SoftwareApplication 用 0 价格表达「有免费额度」，避免误导", () => {
    const doc = buildLandingJsonLdDocument({ locale: "en", description: "d", faq: [] });
    const sw = (doc["@graph"] as Array<Record<string, unknown>>).find(
      (n) => n["@type"] === "SoftwareApplication"
    );
    expect((sw?.offers as Record<string, unknown>)?.price).toBe("0");
    expect((sw?.offers as Record<string, unknown>)?.priceCurrency).toBe("CNY");
  });

  it("serializeJsonLd 转义 < 防止 </script> 提前闭合", () => {
    const obj = { a: "1 < 2 & </script>" };
    const out = serializeJsonLd(obj);
    expect(out).not.toContain("<");
    expect(out).toContain("\\u003c");
  });

  it("无 FAQ 时 @graph 不含 FAQPage", () => {
    const doc = buildLandingJsonLdDocument({ locale: "zh", description: "d" });
    const types = (doc["@graph"] as Array<{ "@type": string }>).map((n) => n["@type"]);
    expect(types).not.toContain("FAQPage");
  });
});
