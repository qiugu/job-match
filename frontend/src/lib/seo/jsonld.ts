// JSON-LD 结构化数据构建器。
//
// 通过 TanStack Router 的 `head().scripts` 注入（参见 routes/$locale.tsx）。
// 注入四类 schema：
//   Organization        —— 品牌实体，知识面板的基础
//   WebSite             —— 站点实体，声明语言与主站关系
//   SoftwareApplication —— 产品实体，说明「在线工具 + 免费额度」
//   FAQPage             —— 落地页问答，补全语义与长尾词覆盖
//
// 说明：2023 年后 Google 对 FAQPage 的富媒体结果已大幅收紧（主要只对政府/医疗
// 类权威站点展示），此处保留 FAQPage 的收益在于语义补全而非富媒体展现，因此
// 同时要求 FAQ 答案真实出现在 SSR HTML 中（见 components/home/FAQSection.tsx）。

import {
  SITE_NAME,
  SITE_URL,
  absoluteUrl,
  canonicalFor,
  type Locale
} from "@/lib/seo/site";

export type FaqEntry = {
  question: string;
  answer: string;
};

export type LandingJsonLdInput = {
  locale: Locale;
  /** 产品名，通常等于站点名。 */
  name?: string;
  /** 站点/产品描述，用于 SoftwareApplication.description。 */
  description: string;
  /** 落地页 FAQ 条目，为空则不输出 FAQPage。 */
  faq?: FaqEntry[];
};

export function buildOrganizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: absoluteUrl("/icon.png")
  };
}

export function buildWebSiteJsonLd(locale: Locale, name = SITE_NAME) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name,
    url: canonicalFor(locale),
    inLanguage: locale
  };
}

/**
 * 产品实体。JDMatch 是纯 Web 应用，注册即赠积分（耗尽后需用注册码补充），
 * 因此 offers 用 0 价格表达「有免费额度」，并用 description 明确额度来源，
 * 避免被判为误导性结构化数据。
 */
export function buildSoftwareApplicationJsonLd(
  locale: Locale,
  name: string,
  description: string
) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name,
    description,
    url: canonicalFor(locale),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web Browser",
    inLanguage: locale,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "CNY",
      availability: "https://schema.org/InStock"
    }
  };
}

export function buildFaqPageJsonLd(entries: FaqEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries
      .filter((entry) => entry.question && entry.answer)
      .map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: entry.answer
        }
      }))
  };
}

/** 落地页所需的全部 schema，按注入顺序返回。 */
export function buildLandingJsonLd({
  locale,
  name = SITE_NAME,
  description,
  faq
}: LandingJsonLdInput): unknown[] {
  const schemas: unknown[] = [
    buildOrganizationJsonLd(),
    buildWebSiteJsonLd(locale, name),
    buildSoftwareApplicationJsonLd(locale, name, description)
  ];

  if (faq && faq.length > 0) {
    schemas.push(buildFaqPageJsonLd(faq));
  }

  return schemas;
}

/**
 * 组合为单一 JSON-LD 文档（`@graph` 形式）。
 * 一个页面只需一个 `<script type="application/ld+json">`，多实体用 @graph 并列，
 * 各节点共享同一份 @context，避免重复声明。
 */
export function buildLandingJsonLdDocument(
  input: LandingJsonLdInput
): Record<string, unknown> {
  const graph = buildLandingJsonLd(input).map((node) => {
    const { "@context": _sharedContext, ...rest } = node as Record<
      string,
      unknown
    >;
    return rest;
  });

  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * 序列化为可安全内嵌到 <script> 的 JSON。
 * 数据来自仓库内静态 i18n 文件，但仍转义 `<` 以阻断 `</script>` 提前闭合，
 * 防止未来文案改为动态来源时引入注入风险。
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
