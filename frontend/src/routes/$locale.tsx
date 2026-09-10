import { createFileRoute, notFound } from "@tanstack/react-router";
import LandingPage from "@/app/(public)/[locale]/page";
import { defaultLocale, locales, type Locale } from "@/i18n/config";
import zhMessages from "@/i18n/locales/zh.json";
import enMessages from "@/i18n/locales/en.json";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_NAME,
  absoluteUrl,
  alternateLinksFor,
  canonicalFor,
  ogLocaleFor
} from "@/lib/seo/site";
import {
  buildLandingJsonLdDocument,
  serializeJsonLd,
  type FaqEntry
} from "@/lib/seo/jsonld";

function resolveLocale(rawLocale: string): Locale {
  if (locales.includes(rawLocale as Locale)) {
    return rawLocale as Locale;
  }
  return defaultLocale;
}

function getMessages(locale: Locale) {
  return locale === "en" ? enMessages : zhMessages;
}

export const Route = createFileRoute("/$locale")({
  head: ({ params }) => {
    const locale = resolveLocale(params.locale);
    const messages = getMessages(locale);

    // seoTitle 为 SEO 专用标题（含检索意图词），缺失时回退品牌名 + 副标题
    const title =
      messages.common.seoTitle ??
      `${messages.common.title} - ${messages.common.subtitle}`;
    const description = messages.common.description;
    const imageAlt = messages.common.seoImageAlt;

    const canonical = canonicalFor(locale);
    const ogImage = absoluteUrl(OG_IMAGE_PATH);
    const alternateOgLocale = ogLocaleFor(locale === "en" ? "zh" : "en");

    // FAQ 来自静态 i18n，结构与 FaqEntry 一致，但 zh/en 联合类型无法直接推断
    const faq = (messages.home.faq?.items ?? []) as unknown as FaqEntry[];
    const jsonLd = serializeJsonLd(
      buildLandingJsonLdDocument({ locale, description, faq })
    );

    return {
      meta: [
        { title },
        { name: "description", content: description },
        { name: "robots", content: "index,follow,max-image-preview:large" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: SITE_NAME },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:locale", content: ogLocaleFor(locale) },
        { property: "og:locale:alternate", content: alternateOgLocale },
        { property: "og:url", content: canonical },
        { property: "og:image", content: ogImage },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: String(OG_IMAGE_WIDTH) },
        { property: "og:image:height", content: String(OG_IMAGE_HEIGHT) },
        { property: "og:image:alt", content: imageAlt },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "twitter:image", content: ogImage },
        { name: "twitter:image:alt", content: imageAlt }
      ],
      links: [
        { rel: "canonical", href: canonical },
        ...alternateLinksFor(locale).map((link) => ({
          rel: "alternate",
          hrefLang: link.hrefLang,
          href: link.href
        }))
      ],
      scripts: [
        {
          type: "application/ld+json",
          children: jsonLd
        }
      ]
    };
  },
  component: LocaleLandingPage
});

function LocaleLandingPage() {
  const { locale } = Route.useParams();

  if (!locales.includes(locale as (typeof locales)[number])) {
    notFound();
  }

  return <LandingPage />;
}
