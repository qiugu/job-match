#!/usr/bin/env node
// 生成 public/sitemap.xml 与 public/robots.txt。
//
// 为什么要脚本生成而非手写：
// 1) 协议必须与生产一致（https）。此前手写文件为 http，与 canonical 打架。
// 2) <lastmod> 需要随发布刷新，手写必然腐化。
// 3) robots 的 Sitemap 行与 sitemap 中的 loc 必须同源，统一生成一个出口最稳。
//
// 用法：node scripts/generate-sitemap.mjs
// 构建前由 package.json 的 prebuild 自动调用；构建期注入 VITE_SITE_URL 可覆盖域名。

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "..", "public");

const DEFAULT_SITE_URL = "https://jdmatch.site";

function resolveSiteUrl(raw) {
  if (typeof raw !== "string") return DEFAULT_SITE_URL;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_SITE_URL;
  if (!/^https?:\/\//i.test(trimmed)) return DEFAULT_SITE_URL;
  return trimmed;
}

const SITE_URL = resolveSiteUrl(process.env.VITE_SITE_URL);

/** 可索引入口：语言落地页 + 公开模板画廊（PLAN_guest_access P1）。 */
const ENTRIES = [
  { path: "/zh", priority: "1.0" },
  { path: "/en", priority: "0.9" },
  { path: "/templates", priority: "0.8" }
];

/** hreflang 互指：每个 URL 都要列出全部语言 + x-default。 */
const ALTERNATES = [
  { hreflang: "zh", path: "/zh" },
  { hreflang: "en", path: "/en" },
  { hreflang: "x-default", path: "/zh" }
];

/** 不参与索引的路径：登录态页面、后端接口、图片代理。 */
const DISALLOWED = ["/app/", "/api/", "/image-proxy"];

const CHANGE_FREQ = "weekly";
const lastmod = new Date().toISOString().slice(0, 10);

function buildUrlEntry({ path, priority }) {
  const alternates = ALTERNATES.map(
    (alt) =>
      `    <xhtml:link rel="alternate" hreflang="${alt.hreflang}" href="${SITE_URL}${alt.path}" />`
  ).join("\n");

  return [
    "  <url>",
    `    <loc>${SITE_URL}${path}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${CHANGE_FREQ}</changefreq>`,
    `    <priority>${priority}</priority>`,
    alternates,
    "  </url>"
  ].join("\n");
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${ENTRIES.map(buildUrlEntry).join("\n")}
</urlset>
`;

const robots = `User-agent: *
Allow: /

${DISALLOWED.map((path) => `Disallow: ${path}`).join("\n")}

# Sitemap
Sitemap: ${SITE_URL}/sitemap.xml
`;

writeFileSync(resolve(publicDir, "sitemap.xml"), sitemap, "utf8");
writeFileSync(resolve(publicDir, "robots.txt"), robots, "utf8");

console.log(
  `[seo] sitemap.xml + robots.txt generated for ${SITE_URL} (lastmod ${lastmod})`
);
