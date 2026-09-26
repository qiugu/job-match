// 站点级 SEO 常量与 URL 构建器。
//
// 为什么需要单独一个模块：
// 全站 canonical / hreflang / sitemap / OG 的协议与域名必须完全一致，且必须与
// 生产实际协议一致。此前基址散落在 `$locale.tsx`、`robots.txt`、`sitemap.xml`、
// `app/layout.tsx` 四处且硬编码为 http://jdmatch.site，而生产（nginx.ssl.conf）
// 已把 80 端口 301 到 HTTPS，导致搜索引擎把 http 与 https 判为两份重复内容，
// 权重被拆分。现在所有入口都从这里取值，杜绝再次漂移。

import { defaultLocale, locales, type Locale } from "@/i18n/config";

export type { Locale } from "@/i18n/config";

/** 生产站点基址（无尾斜杠）。仅作为 VITE_SITE_URL 缺省时的回退。 */
export const DEFAULT_SITE_URL = "https://jdmatch.site";

/**
 * 规范化站点基址：去尾斜杠，拒绝非 http(s) 的畸形值。
 * 单独导出便于单测覆盖各分支，也便于构建脚本复用。
 */
export function resolveSiteUrl(raw?: string | null): string {
  if (typeof raw !== "string") return DEFAULT_SITE_URL;

  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_SITE_URL;
  // 必须是绝对 http(s) 地址：相对的或畸形的值会让 canonical 直接失效
  if (!/^https?:\/\//i.test(trimmed)) return DEFAULT_SITE_URL;

  return trimmed;
}

/**
 * 当前构建的站点基址。
 * import.meta.env 是编译期常量，运行时 env 无效 —— 由 Dockerfile 的 ARG/ENV
 * 与 docker-compose 的 build.args 注入（与 VITE_JOBMATCH_API 同一机制）。
 */
export const SITE_URL = resolveSiteUrl(
  (import.meta.env?.VITE_SITE_URL as string | undefined) ?? null
);

export const SITE_NAME = "JDMatch";

/** 社交分享图：由 scripts/generate-hero-images.mjs 从 web-shot.jpg 裁切生成。 */
export const OG_IMAGE_PATH = "/og-image.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** 站点 logo（结构化数据 Organization.logo 使用）。 */
export const SITE_LOGO_PATH = "/icon.png";

/** 把站内路径拼成绝对 URL；已是绝对地址的按原样返回。 */
export function absoluteUrl(path = "/"): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** 语言落地页路径，如 "zh" -> "/zh"。 */
export function localePath(locale: Locale): string {
  return `/${locale}`;
}

/** 落地页 canonical：始终为 https 且无尾斜杠。 */
export function canonicalFor(locale: Locale): string {
  return absoluteUrl(localePath(locale));
}

export type AlternateLink = { hrefLang: string; href: string };

/**
 * hreflang 三元组：本语言、另一语言、x-default。
 * 三者互指是 Google 多语言站点的硬性要求，缺一即可能被视为信号不完整。
 */
export function alternateLinksFor(locale: Locale): AlternateLink[] {
  const others = locales.filter((item) => item !== locale);

  return [
    { hrefLang: locale, href: canonicalFor(locale) },
    ...others.map((item) => ({
      hrefLang: item,
      href: canonicalFor(item)
    })),
    { hrefLang: "x-default", href: canonicalFor(defaultLocale) }
  ];
}

/** OG 的 locale 标签需为 territory 形式（zh_CN / en_US），而非 zh / en。 */
export function ogLocaleFor(locale: Locale): string {
  return locale === "en" ? "en_US" : "zh_CN";
}

/** 可被爬虫索引的公开路径（sitemap 与 robots 共用同一份来源）。 */
export function indexablePaths(): Array<{
  path: string;
  locale: Locale;
  priority: string;
  changeFrequency: string;
}> {
  return locales.map((locale) => ({
    path: localePath(locale),
    locale,
    priority: locale === defaultLocale ? "1.0" : "0.9",
    changeFrequency: "weekly"
  }));
}

/** 不允许索引的路径前缀（登录态页面与代理接口）。 */
export const DISALLOWED_PATHS = ["/app/", "/api/", "/image-proxy"] as const;
