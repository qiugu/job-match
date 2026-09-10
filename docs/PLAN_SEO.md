# JDMatch SEO 优化方案（待评审）

> 状态：**待评审** · 审计时间：2026-09-10 · 审计范围：`frontend/`（TanStack Start SSR）、`nginx/`、`docker-compose.yml`
> 评审通过后按阶段 S1 → S5 顺序执行，每阶段独立构建 + 测试 + 可回退。

---

## 1. 背景与目标

站点为 **SSR 落地页 + 登录态 SPA** 的双段结构：

- **可索引面**：仅 `/zh`、`/en` 两个落地页（`/` 302 到 `/$locale`）。
- **不可索引面**：`/login`、`/app/**`（工作台、仪表盘、简历编辑器）。

因此 SEO 优化的全部杠杆集中在：**让两个落地页被正确、完整、快速地索引，并具备富媒体展示能力**。

目标（按优先级）：

1. **消除收录歧义**——协议、规范链接、hreflang、robots 完全一致。
2. **提升富媒体与语义理解**——OG/Twitter 卡片可用、JSON-LD 结构化数据齐备。
3. **修复 Core Web Vitals 硬伤**——首屏 16MB 字体预载是当前最大的 LCP 杀手。
4. **夯实内容与语义**——标题层级、图片 alt、多语言文案。

---

## 2. 现状审计结果

### 2.1 P0 —— 直接伤害收录 / 排名

| ID  | 问题 | 证据文件 | 影响 |
| --- | --- | --- | --- |
| P0-1 | 站点基址硬编码 `http://jdmatch.site`，而生产已全站 HTTPS（Nginx 80 → 301 → 443） | `src/routes/$locale.tsx:7` | canonical 指向 http → 搜索引擎判定**重复内容**，权重被拆分；OG 抓取器取到 http 资源 |
| P0-2 | `og:image` / `twitter:image` 指向 `/web-shot.png`，实际文件是 `web-shot.jpg` | `src/routes/$locale.tsx:49,53`；`public/` 仅 `web-shot.jpg` | 社交分享与 IM 预览**全部 404**，零缩略图 |
| P0-3 | 首屏 `<link rel=preload>` 两个中文 TTF：`8.1MB + 7.9MB = 16MB`，且落地页默认字体栈（`Inter, Noto Sans SC, system-ui`）**并不使用 Alibaba PuHuiTi**（该字体仅用于简历编辑器/导出） | `src/routes/__root.tsx:20-35`；`tailwind.config.ts:30`；`src/utils/fonts.ts:16` | LCP 灾难性劣化；移动端首屏基本不可用 |
| P0-4 | 全站**零结构化数据**（无 Organization / WebSite / SoftwareApplication / FAQPage） | 全仓库无 `application/ld+json` | 无富媒体结果、无知识面板，语义理解弱 |
| P0-5 | `sitemap.xml` 仅 2 条、协议为 http、**无 `<lastmod>`** | `public/sitemap.xml` | 爬虫无法判断更新，重抓频率下降 |
| P0-6 | `robots.txt` Sitemap 为 http；未屏蔽 `/app/`、`/image-proxy` | `public/robots.txt` | 登录态页面被抓取，产生大量低质/重复索引 |

### 2.2 P1 —— 影响质量与体验

| ID  | 问题 | 证据文件 | 影响 |
| --- | --- | --- | --- |
| P1-1 | FAQ 答案默认不挂载到 DOM（Radix Accordion 折叠态不渲染内容） | `src/components/home/FAQSection.tsx` | 5 条高质量问答文本**不在 SSR HTML 中**，无法参与索引 |
| P1-2 | `/app/**` 中仅 `dashboard.tsx`、`workbench/$id.tsx` 声明 `noindex`，其余（`/app`、`/app/dashboard/index`、`resumes`、`match`、`jobs`、`templates`、`preview-template/$id`）缺失 | `src/routes/app/*.tsx` | 内页可被索引，稀释站点主题 |
| P1-3 | Hero 主图 `web-shot.jpg` 为 2560×1440 / 328KB 单文件，无 WebP/AVIF、无响应式尺寸、无 `fetchpriority` | `public/web-shot.jpg`；`HeroSection.tsx:65` | LCP 图片浪费约 60–70% 字节 |
| P1-4 | Hero 图 `alt="Resume Editor Preview"` 为硬编码英文，中文站同样输出英文 | `HeroSection.tsx:67` | 多语言站点 alt 与页面语言不一致 |
| P1-5 | `src/app/layout.tsx` 为 Next.js 遗留死代码，`metadataBase` 也是 http；且引入 `next` 类型依赖 | `src/app/layout.tsx:2,12` | 误导后续维护；是既有 `tsc` 报错来源之一 |
| P1-6 | 缺 `manifest.webmanifest`、`theme-color`、`apple-touch-icon`、SVG favicon | `src/routes/__root.tsx:80-84` | 移动端安装/分享体验与品牌一致性受损 |
| P1-7 | `www.jdmatch.site` 与裸域同时 200 提供内容，未做 301 归一（证书 SAN 已覆盖两者，有效期至 2026-11-28） | `nginx/nginx.ssl.conf:24,61`；证书 SAN 已确认 | 潜在域名级重复内容 |

### 2.3 P2 —— 优化项

| ID  | 问题 | 说明 |
| --- | --- | --- |
| P2-1 | 落地页无 `<main>` 包裹（外层为 `<div>`） | `src/app/(public)/[locale]/page.tsx:12` |
| P2-2 | 404 页面无标题、无 `noindex`、无返回入口 | `src/routes/__root.tsx:103-109` |
| P2-3 | sitemap 手工维护，路由变更后易腐化 | 当前 2 条，未来新增页面会漏 |
| P2-4 | Nginx 未启用 Brotli（gzip 已启用，级别 5） | `nginx/nginx.ssl.conf` |
| P2-5 | 无 Lighthouse / CWV 基线数据 | 无法量化优化收益 |

### 2.4 已达标项（无需改动）

| 项 | 状态 |
| --- | --- |
| SSR 输出 | ✅ `dist/server/server.js` 存在，落地页服务端渲染 |
| HTTPS / HSTS / TLS1.3 / OCSP 装订 | ✅ 已配置 |
| HTTP/2、Gzip、静态资源长缓存（30d immutable） | ✅ 已配置 |
| 标题层级 h1 → h2×3 → h3 | ✅ 结构合规，仅 1 个 h1 |
| hreflang 落地页互链 + x-default | ✅ 已声明（需随 P0-1 一并改为 https） |
| 多语言 `<html lang>` | ✅ 由 `getPreferredLocale` 驱动 |

---

## 3. 优化方案

### S1 · 收录一致性（P0-1 / P0-5 / P0-6，P1-2 / P1-7）

| 动作 | 实现 |
| --- | --- |
| 1.1 新增站点基址模块 | `src/lib/seo/site.ts`：`SITE_URL = import.meta.env.VITE_SITE_URL ?? "https://jdmatch.site"`，导出 `absoluteUrl()`、`canonicalFor(path)`、`alternatesFor(locale)`、`ogImageUrl()`。**所有 SEO 常量收敛到单一来源**，禁止再散落硬编码 |
| 1.2 构建期注入 | `frontend/Dockerfile` 增加 `ARG/ENV VITE_SITE_URL`；`docker-compose.yml` 传入 `VITE_SITE_URL: https://jdmatch.site`（与 `VITE_JOBMATCH_API` 同为编译期常量，机制一致） |
| 1.3 重构 `$locale.tsx` head | 改为调用 seo 模块；补齐 `og:image:width/height/alt`、`og:image:type`、`twitter:site`、`theme-color` |
| 1.4 重写 `robots.txt` | 协议改 https；`Disallow: /app/`、`/api/`、`/image-proxy`；`Allow: /`；`Sitemap: https://jdmatch.site/sitemap.xml` |
| 1.5 sitemap 改为生成物 | 新增 `scripts/generate-sitemap.mjs`，输出 `public/sitemap.xml`（含 `<lastmod>`、https、hreflang 三元组），挂到 `package.json` 的 `prebuild` |
| 1.6 `/app/**` 统一 noindex | 在 `src/routes/app/route.tsx`（布局路由）声明 `noindex,nofollow`，删除 `dashboard.tsx` / `workbench/$id.tsx` 中的重复声明（子路由 meta 会覆盖父级，收敛到父级更不易漏） |
| 1.7 www 归一 | `nginx.ssl.conf` 新增 `server { listen 443 ssl; server_name www.jdmatch.site; return 301 https://jdmatch.site$request_uri; }`；80 端口同步处理 |

### S2 · 结构化数据（P0-4 / P1-1）

| 动作 | 实现 |
| --- | --- |
| 2.1 新增 JSON-LD 构建器 | `src/lib/seo/jsonld.ts`，通过 TanStack Router `head().scripts` 注入（已确认 `Matches.d.ts` 支持 `scripts?: Array<JSX.IntrinsicElements['script']>`） |
| 2.2 落地页注入四类 | `Organization` + `WebSite` + `SoftwareApplication`（`applicationCategory: BusinessApplication`、`operatingSystem: Web`、`offers: { price: "0", priceCurrency: "CNY" }` 免费额度语义）+ `FAQPage`（取自 `i18n/locales/{zh,en}.json` 的 `home.faq.items`，随语言切换） |
| 2.3 FAQ 内容 SSR 可见 | `AccordionContent` 启用 `forceMount`，用 `hidden` + CSS 控制折叠，保证答案文本进入 SSR HTML（**取舍说明**：2023 年后 Google 对 FAQPage 富媒体结果已大幅收紧，此处收益主要在语义补全与长尾词覆盖，不在富媒体展示） |
| 2.4 校验 | 构建后对 SSR HTML 做正则断言（单测），确保 `application/ld+json` 可被解析且 `JSON.parse` 通过 |

### S3 · Core Web Vitals（P0-3 / P1-3）

| 动作 | 实现 | 预期收益 |
| --- | --- | --- |
| 3.1 **移除 16MB 字体预载** | 删除 `__root.tsx` 中 2 个 Alibaba PuHuiTi TTF preload。该字体仅编辑器和 PDF 导出使用（`src/utils/fonts.ts`、`Document.tsx`），落地页零使用 | 首屏字节 −16MB，LCP 数量级改善 |
| 3.2 Hero 图多格式 + 响应式 | `scripts/generate-hero-images.mjs`（sharp 已在依赖）生成 `web-shot-1200/1920.webp` + avif；`HeroSection` 改 `<picture>` + `srcSet`，保留 jpg 兜底，加 `fetchpriority="high"`、`decoding="async"` | 图片字节 −60%+ |
| 3.3 OG 图生成 | 由 `web-shot.jpg` 用 sharp 裁切为 `og-image.png` 1200×630（<300KB），修复 P0-2 的 404 | 分享卡片恢复 |
| 3.4 字体策略（可选，视 3.1 后实测） | 若仍需要中文 webfont，用 `pyftsubset` 生成常用字集 woff2 子集并 `preload` 单文件；**默认不做**，避免过度工程 | — |

### S4 · 语义与内容（P1-4 / P1-5 / P1-6 / P2-1 / P2-2）

| 动作 | 实现 |
| --- | --- |
| 4.1 alt 多语言化 | Hero alt 走 `t("hero.imageAlt")`；Features 区图片补 alt（当前为空） |
| 4.2 删除 Next.js 遗留文件 | 删除 `src/app/layout.tsx`（无外部引用；样式已由 `__root.tsx` 引入）。**需你确认** |
| 4.3 补充 PWA 元信息 | `public/manifest.webmanifest`、`apple-touch-icon`、`theme-color`（light/dark） |
| 4.4 落地页 `<main>` 包裹 | `page.tsx` 外层 `div` → `main`；`<header>`/`<footer>` 已存在 |
| 4.5 404 页面 | `RootNotFound` 补 `<main>`、标题、返回首页链接 |
| 4.6 Title/Description 调优 | 见 §5 文案提案（需你确认措辞） |

### S5 · 基础设施与度量（P2-3 / P2-4 / P2-5）

| 动作 | 实现 |
| --- | --- |
| 5.1 CWV 基线 | 执行前后各跑一次 Lighthouse（mobile profile），输出 LCP / CLS / TBT 对比表，作为验收量化依据 |
| 5.2 Brotli（可选） | alpine nginx 需 `ngx_brotli` 模块，当前镜像未编译；**标记为可选项**，若不想换基础镜像则跳过 |
| 5.3 索引提交 | 优化上线后向 Google Search Console / Bing Webmaster 提交 sitemap（需你提供账号权限，或由你手动提交） |

---

## 4. 改动文件清单

**新增**

```
frontend/src/lib/seo/site.ts            站点基址与规范链接构建
frontend/src/lib/seo/jsonld.ts          JSON-LD 结构化数据构建
frontend/scripts/generate-sitemap.mjs   sitemap 生成（prebuild）
frontend/scripts/generate-hero-images.mjs Hero/OG 图片生成
frontend/public/manifest.webmanifest    PWA 元信息
frontend/tests/seo.test.ts              单测
docs/SEO.md                             实施说明与验收记录（S5 产出）
```

**修改**

```
frontend/src/routes/__root.tsx          移除字体 preload；补 theme-color/manifest/apple-touch-icon
frontend/src/routes/$locale.tsx         接入 seo 模块；补 OG 尺寸/alt；注入 JSON-LD
frontend/src/routes/app/route.tsx       统一 noindex
frontend/src/routes/app/dashboard.tsx   删除重复 noindex
frontend/src/routes/app/workbench/$id.tsx 删除重复 noindex
frontend/src/components/home/HeroSection.tsx   picture/srcSet/fetchpriority/alt 多语言
frontend/src/components/home/FAQSection.tsx    forceMount 保证 SSR 可见
frontend/src/app/(public)/[locale]/page.tsx    div → main
frontend/src/i18n/locales/{zh,en}.json  新增 hero.imageAlt、features 图片 alt
frontend/public/robots.txt              https + 屏蔽规则
frontend/public/sitemap.xml             改为生成物（内容刷新）
frontend/package.json                   新增 prebuild / generate:assets 脚本
frontend/Dockerfile                     VITE_SITE_URL 构建参数
docker-compose.yml                      VITE_SITE_URL 传参
nginx/nginx.ssl.conf                    www → 裸域 301
```

**删除**

```
frontend/src/app/layout.tsx             Next.js 遗留死代码（待你确认）
```

---

## 5. Title / Description 文案提案（待确认）

**中文** `/zh`

- Title：`JDMatch - AI 简历匹配与优化工具 | 按 JD 自动定制简历`（38 字符）
- Description：`上传简历与目标 JD，JDMatch 用 AI 分析岗位要求并重写简历，输出匹配度评分与优化建议，一键生成定制简历与求职话术。注册即送 50 积分。`（约 78 字）

**English** `/en`

- Title：`JDMatch - AI Resume Matcher & Tailoring for Any JD`
- Description：`Upload your resume and a target job description. JDMatch scores the match, rewrites your resume to fit the role, and drafts a tailored cover letter. 50 free credits on signup.`

> 现有文案（`i18n/locales/*/common.json` 的 `subtitle` / `description`）偏品牌介绍，缺少「简历优化」「匹配度」「求职信」等检索意图词。是否采用上述措辞，或保留现有文案，请确认。

---

## 6. 测试与验收

**单元测试**（`pnpm test`，vitest / node 环境，新增 `tests/seo.test.ts`）

| 用例 | 断言 |
| --- | --- |
| 站点基址 | 未注入 env 时回退 `https://jdmatch.site`；注入时使用注入值 |
| canonical | `/zh` → `https://jdmatch.site/zh`，无重复斜杠、无尾斜杠（根路径除外） |
| alternates | 返回 zh/en/x-default 三元组且全为 https |
| OG | `og:image` 指向存在的文件且带 width/height/alt |
| JSON-LD | 四类 schema 均可 `JSON.parse`；FAQPage 条数 = i18n items 条数；`@context` 正确 |
| robots | 规则函数对 `/app/**`、`/api/**` 返回 false，对 `/zh`、`/en` 返回 true |
| sitemap | 生成器输出 XML 合法、`loc` 全 https、含 `lastmod` 与 hreflang |

**构建校验**

- `npx vite build --outDir /tmp/seo-verify` 通过（**不使用 `pnpm build`**：该命令在本机会触发 safe-delete 守卫，属既有环境问题，非代码问题）
- 启动 `node server.mjs` 后 `curl -s http://localhost:3005/zh | grep -E 'canonical|application/ld\+json|og:image'` 命中预期内容
- `curl -o /dev/null -w '%{http_code}' https://jdmatch.site/og-image.png` → 200（上线后）
- `curl -A "Googlebot" -s https://jdmatch.site/robots.txt` 内容正确（上线后）

**验收标准**

1. 全站 canonical / hreflang / sitemap / robots 全部 https，无一处 http。
2. `/zh`、`/en` 的 SSR HTML 含 4 类 JSON-LD 且可被 Google 富媒体测试工具解析。
3. `/app/**` 全部输出 `noindex,nofollow`。
4. 首屏不再预载 TTF；Lighthouse mobile LCP 相对基线显著下降（具体数值以 S5-1 基线为准）。
5. `pnpm test` 全绿；`tsc --noEmit` 无**新增**报错（既有 legacy 报错按文件名过滤）。

---

## 7. 风险与回退

| 风险 | 等级 | 处置 |
| --- | --- | --- |
| 移除字体 preload 后编辑器首屏字体短暂闪烁 | 低 | 该字体本就 `font-display: swap`；编辑器页可按需单独加 preload（S3.4 备选） |
| canonical 从 http 改 https 后旧 URL 权重波动 | 低 | 属纠正性变更，短期波动后收敛；配合 sitemap 重提交加速重抓 |
| www 301 影响已分享的 www 链接 | 低 | 301 永久跳转，权重传递；证书 SAN 已覆盖 www，无证书告警 |
| Hero 改 `<picture>` 影响现有样式 | 中 | 保留原 jpg 兜底与相同 className；构建后本地目视 + 冒烟 |
| 删除 `src/app/layout.tsx` | 低 | 已确认无外部引用；若你不确定，可改为移动到 `docs/archive/` 而非删除 |
| sitemap 改生成物后忘记执行 | 低 | 挂 `prebuild` 自动执行，不依赖手工 |

---

## 8. 需你确认的决策点

1. **S4.2 删除 `src/app/layout.tsx`**：直接删除 / 移到 `docs/archive/` / 保留？
2. **§5 文案**：采用提案措辞 / 保留现有文案 / 你给出新文案？
3. **S3.3 OG 图**：由 `web-shot.jpg` 自动裁切生成（推荐，无设计成本）/ 你提供设计稿？
4. **S5.2 Brotli**：跳过（推荐，避免换 nginx 基础镜像）/ 启用？
5. **S5.3 索引提交**：你手动提交 / 需要我输出提交指引文档？

---

## 9. 不在本次范围内

- 内容型页面（博客、模板详情页、JD 库等）——这类页面才是长期自然流量的主力，但涉及产品形态决策，建议单独立项。
- 后端 API 的 SEO（无意义，已在 robots 屏蔽）。
- 外链建设、ASO/ASO 等站外手段。
