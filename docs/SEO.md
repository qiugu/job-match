# JDMatch 技术 SEO 优化说明

> 关联计划：`docs/PLAN_SEO.md`
> 落地日期：2026-09-10
> 范围：纯技术 SEO（收录一致性、结构化数据、Core Web Vitals、语义结构）。**不含**内容型页面（模板详情、JD 库、写作指南等），该部分属产品形态，建议单独立项。

## 1. 修复的三个 P0 问题

| # | 问题 | 修复 |
|---|------|------|
| P0-1 | 全站 `canonical` 指向 `http://jdmatch.site`，而生产已全站 HTTPS，被判重复内容、权重拆分 | 新增 `src/lib/seo/site.ts` 收敛基址（构建期 `VITE_SITE_URL` 注入，缺省回退 `https://jdmatch.site`），所有 canonical/OG/hreflang/sitemap 统一从此取值 |
| P0-2 | `og:image` 指向 `/web-shot.png`（实际文件是 `.jpg`），社交分享预览全部 404 | 由 `scripts/generate-hero-images.mjs` 从 `web-shot.jpg` 裁切生成 `og-image.png`（1200×630），并产出 Hero 多尺寸/多格式图 |
| P0-3 | 首屏预载两个 Alibaba PuHuiTi TTF（8.1MB+7.9MB），而该字体仅简历编辑器/PDF 导出使用，每个访客白下载 16MB，LCP 数量级劣化 | 移除 `__root.tsx` 中的字体 `preload`；该字体保持编辑器侧按需加载 |

## 2. 改动清单

### 收录一致性（S1）
- `src/lib/seo/site.ts`（新增）—— 站点级 URL 构建器，`SITE_URL` / `canonicalFor` / `alternateLinksFor` / `ogLocaleFor` / `indexablePaths` / `DISALLOWED_PATHS`。
- `src/routes/$locale.tsx` —— head 改用 `site.ts`：https canonical、hreflang 三元组（本语言+另一语言+x-default）、OG/Twitter 全字段、JSON-LD `scripts` 注入。
- `scripts/generate-sitemap.mjs`（新增）—— 生成 `public/sitemap.xml`（含 `lastmod`/`changefreq`/优先级/`xhtml:link` hreflang）与 `public/robots.txt`（`Allow: /` + 屏蔽 `/app/`、`/api/`、`/image-proxy` + Sitemap 行）。
- `package.json` —— `prebuild` 自动跑 sitemap 生成；新增 `generate:sitemap`、`generate:assets` 命令。
- `frontend/Dockerfile` 与 `docker-compose.yml` —— 注入 `VITE_SITE_URL`（默认 `https://jdmatch.site`，与 `VITE_JOBMATCH_API` 同一机制）。
- `nginx/nginx.ssl.conf` —— 已确认 HTTP 80 与 HTTPS www 两处均 301 归一到裸域 `https://jdmatch.site`（证书 SAN 覆盖 www）。

### 结构化数据（S2）
- `src/lib/seo/jsonld.ts`（新增）—— `Organization` / `WebSite` / `SoftwareApplication` / `FAQPage` 四类 schema，经 `@graph` 合并为单个 `<script type="application/ld+json">`；序列化时转义 `<` 防 `</script>` 提前闭合。
- `src/components/home/FAQSection.tsx` + `src/components/ui/accordion.tsx` —— FAQ 答案用 `forceMount` 进入 SSR HTML（配合 `data-[state=closed]:hidden` 保持视觉收起），保证富语义文本对爬虫可见、且非 cloaking。

### Core Web Vitals（S3）
- `scripts/generate-hero-images.mjs`（新增，依赖 `sharp`）—— 生成 `web-shot-{1200,1920}.webp/.avif`（AVIF 1200w 约 25KB，比原图省 ~92%）与 `og-image.png`。
- `src/components/home/HeroSection.tsx` —— 改为 `<picture>`（AVIF→WebP→jpg 回退）+ `srcSet` + `fetchpriority="high"` + `decoding="async"` + 保留 `width/height` 防 CLS。
- `src/lib/image.tsx` —— `Image` 组件支持透传 `fetchpriority` 等属性。
- `frontend/server.mjs` —— 确认 MIME 映射含 `.avif` / `.webp` / `.webmanifest`（生产静态服务正确）。

### 语义与内容（S4）
- 删除 Next.js 遗留死代码：`src/app/layout.tsx`、`src/app/(public)/[locale]/layout.tsx`（均含 `import { Metadata } from "next"`，非 TanStack 路由文件，无引用）。
- `src/app/(public)/[locale]/page.tsx` —— 外层 `div` 改为 `<main>`，与 `LandingHeader`(header/nav)、`Footer`(footer) 形成正确 landmark。
- `frontend/public/manifest.webmanifest`（新增）+ `__root.tsx` 注入 `manifest` / `apple-touch-icon` / `theme-color`。
- i18n（`zh.json` / `en.json`）—— 采用含检索意图词的 Title/Description（`seoTitle`、`seoImageAlt`、`hero.imageAlt`），落地页图片 `alt` 多语言化。

### 测试与文档（S5）
- `tests/seo.test.ts`（新增，20 断言全绿）—— 覆盖 `resolveSiteUrl`、canonical、alternateLinksFor、ogLocaleFor、OG 路径、JSON-LD @graph 与 FAQ 过滤、序列化转义等。
- 本文件 `docs/SEO.md`。

## 3. 验证结果（构建后 SSR 实测）

对 `/zh` 与 `/en` 两个落地页做 SSR HTML 实测，关键信号全部正确：

| 信号 | 期望 | /zh | /en |
|------|------|-----|-----|
| canonical 为 https | ✓ | ✓ | ✓ |
| canonical 残留 http | 0 | 0 | 0 |
| JSON-LD 注入 | ✓ | ✓ | ✓ |
| FAQPage 实体 | ✓（5 条） | ✓ | ✓ |
| og:image = og-image.png | ✓ | ✓ | ✓ |
| og:image 残留 web-shot.png | 0 | 0 | 0 |
| twitter:card | ✓ | ✓ | ✓ |
| manifest / apple-touch-icon / theme-color | ✓ | ✓ | ✓ |
| `<main>` / `<h1>` / `<header>`/`<nav>` / `<footer>` landmark | ✓ | ✓ | ✓ |

> 注：hreflang 经 TanStack `head().links` 输出为 `hrefLang`（camelCase）。HTML5 属性名大小写不敏感，解析后与 `hreflang` 等价，主流爬虫（Googlebot/Bing）均正常读取；同时 sitemap 内已用标准小写 `<xhtml:link hreflang>` 提供权威信号，多语言标注双保险。

## 4. 构建与脚本

```bash
# 安装依赖（hero 图脚本依赖 sharp）
pnpm install

# 重新生成 sitemap / robots（构建前会自动跑，也可手动）
pnpm generate:sitemap

# 源截图 web-shot.jpg 变更后，重新生成 Hero 多格式图与 OG 图
pnpm generate:assets

# 正常构建（prebuild 会先跑 sitemap 生成）
pnpm build

# 运行 SEO 单测
npx vitest run tests/seo.test.ts
```

生产构建通过 `VITE_SITE_URL` 注入站点域名（Dockerfile ARG / compose build.args）。若换域名，只需改 `docker-compose.yml` 中 `VITE_SITE_URL` 并重新构建，全站 canonical/OG/sitemap 自动跟随，无需改代码。

## 5. 手动提交 sitemap（用户选择：手动提交）

部署新版本后，在搜索引擎控制台手动提交一次即可，无需配置自动推送。

### Google Search Console
1. 访问 https://search.google.com/search-console 并使用站点所有者账号登录。
2. 若尚未验证 `jdmatch.site` 所有权：左侧「设置 → 所有权验证」，选择「网页前缀」`https://jdmatch.site/`，按提示在 `public/` 放置 `googleXXXXXXXX.html` 验证文件（或添加 DNS TXT 记录）。验证一次即长期有效。
3. 左侧「站点地图」→ 输入 `sitemap.xml` → 提交。
4. 提交后通常 1–3 天可看到「已发现网址数」。可在「网址检查」中粘贴 `https://jdmatch.site/zh` 验证 canonical 与索引状态。

### Bing Webmaster Tools
1. 访问 https://www.bing.com/webmasters 登录并添加 `jdmatch.site`。
2. 验证所有权（同样支持 DNS TXT 或 meta 标签）。
3. 「站点地图」→ 提交 `https://jdmatch.site/sitemap.xml`。
4. 因 Bing 与 Yahoo 共用索引，提交 Bing 即覆盖两者。

### 提交后复查清单
- [ ] `https://jdmatch.site/zh`、`/en` 均返回 200 且 canonical 为 https。
- [ ] `robots.txt` 可访问：`https://jdmatch.site/robots.txt`，Sitemap 行指向正确。
- [ ] `sitemap.xml` 可访问且 `<loc>` 全为 https。
- [ ] 社交预览工具（如 https://www.linkedin.com/post-inspector/ ）抓取 `/zh` 显示 OG 图而非空卡片。

## 6. 已知限制与后续

1. **可索引内容仅两个落地页**。技术 SEO 做到满分只是把这两页排名推上去；真正的自然流量来自内容型页面（模板详情、JD 库、简历写作指南）。这部分涉及产品形态，建议单独立项，不要混入本 SEO 任务。
2. **`/app/**` 为 `ssr: false`（SPA 仅客户端渲染）**，其 `noindex` meta 在 SSR HTML 中不一定出现；robots.txt 的 `Disallow: /app/` 是主信号，已覆盖。如需更稳，可后续将 `/app` 路由改为 SSR 或在其入口强制注入 noindex。
3. **`hreflang` camelCase** 见第 3 节说明，属框架原生行为，不影响收录。
4. 前后端共用 `ResumeData` 契约；本次未改动数据模型，无需运行 Alembic 迁移。
