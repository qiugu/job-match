/**
 * 简历模板页（/app/dashboard/templates）的示例 Markdown 正文。
 *
 * 每个模板的差异体现在三个层面，缺一不可：
 * 1. **版式变体**（config/markdownTemplates/index.ts 的 variant）：模块标题/姓名标题的渲染样式；
 * 2. **模块组合与顺序**：例如时间轴模板「履历→里程碑→教育→技能」，瑞士模板「教育→技能表格→经历→项目」；
 * 3. **条目格式**：日期在标题里 / 独立成行 / 右侧日期栏 / 左置日期，正文用列表还是段落。
 *
 * 编写约束（必须遵守，否则 MarkdownPreview 的后处理会把示例排错版）：
 * - 不要出现「<p> 里含 `·` 且带中文全角括号」的整段（会被提升为 .mod-item-title）；
 * - 不要出现「独立段落里含 ` - `（空格 + 半角连字符 + 空格）」的日期区间（会被提升为居中大标题）。
 *   日期区间统一用 en dash `–`，或放进标题/对齐容器里；
 * - 不要使用【】作模块标题（模板是人工撰写的正规 Markdown，不需要该兜底）。
 */

/** 中文示例正文（key = 模板 id） */
export const MARKDOWN_SAMPLE_ZH: Record<string, string> = {
  // 经典：模块顺序 技能→经历→项目→教育，条目为「公司 · 职位（日期）」+ 列表
  classic: `# 宋哈娜 | 高级前端工程师

138-0013-8000 · zhangsan@example.com · 北京市朝阳区

## 专业技能

- **前端框架**：React、Vue.js、Next.js、Nuxt.js 等 SSR 框架
- **开发语言**：TypeScript、JavaScript（ES6+）、HTML5、CSS3
- **工程化**：Webpack、Vite、Rollup、Babel、ESLint
- **性能优化**：首屏加载优化、代码分割、懒加载、性能监控

## 工作经历

### 字节跳动 · 高级前端工程师（2021.07 – 2024.12）

- 负责抖音创作者平台的开发与维护，主导多个核心功能的技术方案设计
- 优化项目工程化配置，将构建时间从 8 分钟压缩至 2 分钟
- 主导性能优化专项，平台首屏加载时间降低 50%，接入 APM 监控体系

### 腾讯 · 前端工程师（2019.03 – 2021.06）

- 负责微信小程序开发者工具核心模块开发，服务数十万开发者
- 基于 Electron 构建跨平台桌面应用，覆盖 Windows、macOS、Linux

## 项目经历

### 抖音创作者中台 · 前端负责人（2022.06 – 2023.12）

- 基于 React 的创作者数据分析与内容管理平台，服务百万级创作者
- 落地内部组件库与数据流治理，代码复用率提升至 70%

## 教育经历

### 北京大学 · 计算机科学与技术（2013.09 – 2017.06）

- 专业排名前 5%，连续三年获得一等奖学金
- 参与开源项目贡献，获得 GitHub Campus Expert 认证`,

  // 商务：模块顺序 经历→项目→技能→教育，机构靠左 / 日期靠右，联系信息同样左右分布
  modern: `# 宋哈娜 | 高级前端工程师

:::left 138-0013-8000 · zhangsan@example.com ::: :::right 北京市朝阳区 :::

## 工作经历

:::left **字节跳动** · 高级前端工程师 ::: :::right 2021.07 – 2024.12 :::

- 负责抖音创作者平台的开发与维护，主导核心功能的技术方案设计
- 优化工程化配置，构建时间从 8 分钟压缩至 2 分钟
- 主导性能优化专项，首屏加载时间降低 50%

:::left **腾讯** · 前端工程师 ::: :::right 2019.03 – 2021.06 :::

- 负责微信小程序开发者工具核心模块开发，服务数十万开发者
- 基于 Electron 构建跨平台桌面应用，覆盖三大主流系统

## 项目经历

:::left **抖音创作者中台** · 前端负责人 ::: :::right 2022.06 – 2023.12 :::

- 基于 React 的数据分析与内容管理平台，服务百万级创作者
- 落地内部组件库，代码复用率提升至 70%

## 专业技能

- **前端框架**：React、Vue.js、Next.js、Nuxt.js
- **开发语言**：TypeScript、JavaScript（ES6+）、HTML5、CSS3
- **工程化**：Webpack、Vite、Rollup、Babel、ESLint

## 教育经历

:::left **北京大学** · 计算机科学与技术 ::: :::right 2013.09 – 2017.06 :::

- 专业排名前 5%，连续三年获得一等奖学金`,

  // 侧栏：左内容块（摘要 + 要点）/ 右日期栏（日期 + 城市），标题带左侧竖条
  "left-right": `# 宋哈娜 | 高级前端工程师

138-0013-8000 · zhangsan@example.com · 北京市朝阳区

## 专业技能

- **前端框架**：React、Vue.js、Next.js、Nuxt.js
- **开发语言**：TypeScript、JavaScript（ES6+）
- **工程化**：Webpack、Vite、Rollup、ESLint
- **性能优化**：首屏加载、代码分割、懒加载

## 工作经历

:::left
**字节跳动 · 高级前端工程师**

负责抖音创作者平台的前端架构与技术演进，带领 6 人小组完成中台化改造。

- 主导核心功能技术方案设计，需求交付周期缩短 30%
- 优化工程化配置，构建时间从 8 分钟压缩至 2 分钟
- 建立前端监控体系，线上故障率下降 45%
:::
:::right
2021.07 – 2024.12
北京
:::

:::left
**腾讯 · 前端工程师**

负责微信小程序开发者工具的核心模块研发与开发者体验优化。

- 完成调试器与编译器模块重构，工具启动速度提升 40%
- 基于 Electron 交付跨平台桌面应用
:::
:::right
2019.03 – 2021.06
深圳
:::

## 项目经历

:::left
**抖音创作者中台 · 前端负责人**

从 0 到 1 搭建创作者数据分析与内容管理平台，服务百万级创作者。

- 落地内部组件库，代码复用率提升至 70%
:::
:::right
2022.06 – 2023.12
:::

## 教育经历

:::left
**北京大学 · 计算机科学与技术**

专业排名前 5%，连续三年获得一等奖学金。
:::
:::right
2013.09 – 2017.06
:::`,

  // 时间轴：日期作小标题，模块为 职业履历→项目里程碑→教育背景→专业技能，条间用分隔线
  timeline: `# 宋哈娜 | 高级前端工程师

138-0013-8000 · zhangsan@example.com · 北京市朝阳区

## 职业履历

### 2021.07 – 2024.12

**字节跳动** —— 高级前端工程师

- 负责抖音创作者平台的前端架构与技术演进，带领 6 人小组完成中台化改造
- 主导性能优化专项，首屏加载时间降低 50%

---

### 2019.03 – 2021.06

**腾讯** —— 前端工程师

- 负责微信小程序开发者工具核心模块开发，服务数十万开发者
- 基于 Electron 构建跨平台桌面应用

---

### 2017.07 – 2019.02

**美团** —— 前端开发工程师

- 负责商家后台管理系统开发与内部组件库建设

---

## 项目里程碑

### 2022.06 – 2023.12

**抖音创作者中台** —— 前端负责人

- 基于 React 的数据分析与内容管理平台，服务百万级创作者
- 落地内部组件库，代码复用率提升至 70%

---

## 教育背景

### 2013.09 – 2017.06

**北京大学** —— 计算机科学与技术

- 专业排名前 5%，连续三年获得一等奖学金

## 专业技能

- React、Vue.js、TypeScript、Next.js、Nuxt.js
- Webpack、Vite、Rollup、性能监控、工程化治理`,

  // 极简：技能压缩成一行，只保留 经历 / 项目 / 教育 三个模块，日期独立成行
  minimalist: `# 宋哈娜

高级前端工程师 · 北京 · 138-0013-8000 · zhangsan@example.com

React · Vue.js · TypeScript · Next.js · Vite · 性能优化

## 工作经历

### 字节跳动 · 高级前端工程师

2021.07 – 2024.12

- 负责抖音创作者平台的前端架构与技术演进
- 主导性能优化专项，首屏加载时间降低 50%

### 腾讯 · 前端工程师

2019.03 – 2021.06

- 负责微信小程序开发者工具核心模块开发

## 项目经历

### 抖音创作者中台 · 前端负责人

- 基于 React 的数据分析与内容管理平台，服务百万级创作者
- 落地内部组件库，代码复用率提升至 70%

## 教育经历

### 北京大学 · 计算机科学与技术

- 专业排名前 5%，连续三年获得一等奖学金`,

  // 优雅：居中头部，开篇用「个人简述」段落，模块 简述→经历→教育→技能
  elegant: `:::center
# 宋哈娜
高级前端工程师 · 北京 · 138-0013-8000 · zhangsan@example.com
:::

## 个人简述

深耕前端工程八年，专注大型 B 端平台的架构演进与性能治理，主导过百万级创作者产品的技术选型与团队建设，擅长把复杂业务拆解为可复用的前端能力。

## 工作经历

### 字节跳动 · 高级前端工程师（2021.07 – 2024.12）

- 负责抖音创作者平台的前端架构与技术演进，带领 6 人小组完成中台化改造
- 主导性能优化专项，首屏加载时间降低 50%，建立前端监控体系

### 腾讯 · 前端工程师（2019.03 – 2021.06）

- 负责微信小程序开发者工具核心模块开发，服务数十万开发者
- 基于 Electron 交付跨平台桌面应用

## 教育经历

### 北京大学 · 计算机科学与技术（2013.09 – 2017.06）

- 专业排名前 5%，连续三年获得一等奖学金

## 专业技能

- React、Vue.js、TypeScript、Next.js、Nuxt.js
- Webpack、Vite、Rollup、ESLint、性能监控`,

  // 创意：项目优先且成果数据化，工作经历与教育经历压缩为单行，姓名超大 + 引言摘要
  creative: `# 宋哈娜

**高级前端工程师**

138-0013-8000 · zhangsan@example.com · 北京市朝阳区 · github.com/hana

> 把复杂业务拆成可复用的前端能力——八年 B 端平台架构与性能治理经验。

## 项目经历

### 抖音创作者中台

**前端负责人 · 2022.06 – 2023.12**

- 从 0 到 1 搭建创作者数据分析与内容管理平台，服务 **100 万+** 创作者
- 落地内部组件库，代码复用率从 30% 提升到 **70%**
- 首屏加载时间下降 **50%**，接入 APM 监控后线上故障率下降 45%

### 前端监控 SDK

**发起人 · 2021.09 – 2022.03**

- 自研错误与性能采集 SDK，日上报量 **2000 万+**
- 打通告警链路，平均故障定位时间从 2 小时缩短到 15 分钟

## 专业技能

- **框架**：React、Vue.js、Next.js、Nuxt.js
- **语言**：TypeScript、JavaScript（ES6+）
- **工程化**：Webpack、Vite、Rollup、Monorepo

## 工作经历

### 字节跳动 · 高级前端工程师

2021.07 – 2024.12

### 腾讯 · 前端工程师

2019.03 – 2021.06

## 教育经历

### 北京大学 · 计算机科学与技术

2013.09 – 2017.06`,

  // 画报：超大姓名 + 斜体副标题 + 导语段落，正文用段落叙述而非列表，技能一行收尾
  editorial: `# 宋哈娜

*高级前端工程师 · 北京*

八年前端工程经验。专注大型 B 端平台的架构演进与性能治理，擅长在高速迭代的业务里守住工程质量的底线。

138-0013-8000 · zhangsan@example.com · github.com/hana

## 工作经历

### 字节跳动 · 高级前端工程师（2021.07 – 2024.12）

负责抖音创作者平台的前端架构与技术演进。平台服务百万级创作者，团队规模 6 人。主导中台化改造，将构建时间从 8 分钟压缩到 2 分钟；带领性能优化专项，首屏加载时间降低 50%，并建立前端监控体系。

### 腾讯 · 前端工程师（2019.03 – 2021.06）

负责微信小程序开发者工具核心模块开发，服务数十万开发者。基于 Electron 交付跨平台桌面应用，覆盖三大主流系统。

## 项目经历

### 抖音创作者中台 · 前端负责人（2022.06 – 2023.12）

基于 React 的创作者数据分析与内容管理平台。落地内部组件库，代码复用率提升至 70%。

## 教育经历

### 北京大学 · 计算机科学与技术（2013.09 – 2017.06）

专业排名前 5%，连续三年获得一等奖学金。

## 专业技能

React · Vue.js · TypeScript · Next.js · Webpack · Vite · 性能监控`,

  // 瑞士：教育背景 + 表格化技能前置，日期左置并带地点，最后才是经历与项目
  swiss: `# 宋哈娜 | 高级前端工程师

138-0013-8000 · zhangsan@example.com · 北京市朝阳区

## 教育背景

### 北京大学 · 计算机科学与技术

2013.09 – 2017.06 · 本科 · 专业排名前 5%

## 专业技能

| 领域 | 技术栈 |
| --- | --- |
| 框架 | React、Vue.js、Next.js、Nuxt.js |
| 语言 | TypeScript、JavaScript（ES6+） |
| 工程化 | Webpack、Vite、Rollup、Monorepo |
| 性能 | 代码分割、懒加载、APM 监控 |

## 工作经历

### 字节跳动 · 高级前端工程师

2021.07 – 2024.12 · 北京

- 负责抖音创作者平台的前端架构与技术演进
- 主导性能优化专项，首屏加载时间降低 50%

### 腾讯 · 前端工程师

2019.03 – 2021.06 · 深圳

- 负责微信小程序开发者工具核心模块开发

## 项目经历

### 抖音创作者中台 · 前端负责人

2022.06 – 2023.12

- 基于 React 的数据分析与内容管理平台，服务百万级创作者`,
};

/** 英文示例正文（key = 模板 id），结构与中文版一一对应 */
export const MARKDOWN_SAMPLE_EN: Record<string, string> = {
  classic: `# Hana Song | Senior Frontend Engineer

138-0013-8000 · hana@example.com · Chaoyang District, Beijing

## Skills

- **Frameworks**: React, Vue.js, Next.js, Nuxt.js
- **Languages**: TypeScript, JavaScript (ES6+), HTML5, CSS3
- **Tooling**: Webpack, Vite, Rollup, Babel, ESLint
- **Performance**: Code splitting, lazy loading, APM monitoring

## Experience

### ByteDance · Senior Frontend Engineer（2021.07 – 2024.12）

- Owned the Douyin Creator Platform and led technical design for core features
- Reworked the build toolchain, cutting CI time from 8 minutes to 2 minutes
- Led a performance program that reduced first paint by 50%

### Tencent · Frontend Engineer（2019.03 – 2021.06）

- Built core modules of the WeChat Mini Program DevTools for 100k+ developers
- Shipped a cross-platform Electron app for Windows, macOS and Linux

## Projects

### Douyin Creator Console · Frontend Lead（2022.06 – 2023.12）

- React-based analytics and content platform serving millions of creators
- Introduced a shared component library that raised code reuse to 70%

## Education

### Peking University · Computer Science（2013.09 – 2017.06）

- Top 5% of the major, first-class scholarship three years in a row
- Open source contributor, GitHub Campus Expert`,

  modern: `# Hana Song | Senior Frontend Engineer

:::left 138-0013-8000 · hana@example.com ::: :::right Chaoyang District, Beijing :::

## Experience

:::left **ByteDance** · Senior Frontend Engineer ::: :::right 2021.07 – 2024.12 :::

- Owned the Douyin Creator Platform and led technical design for core features
- Reworked the build toolchain, cutting CI time from 8 minutes to 2 minutes
- Led a performance program that reduced first paint by 50%

:::left **Tencent** · Frontend Engineer ::: :::right 2019.03 – 2021.06 :::

- Built core modules of the WeChat Mini Program DevTools for 100k+ developers
- Shipped a cross-platform Electron app for Windows, macOS and Linux

## Projects

:::left **Douyin Creator Console** · Frontend Lead ::: :::right 2022.06 – 2023.12 :::

- React-based analytics and content platform serving millions of creators
- Introduced a shared component library that raised code reuse to 70%

## Skills

- **Frameworks**: React, Vue.js, Next.js, Nuxt.js
- **Languages**: TypeScript, JavaScript (ES6+), HTML5, CSS3
- **Tooling**: Webpack, Vite, Rollup, Babel, ESLint

## Education

:::left **Peking University** · Computer Science ::: :::right 2013.09 – 2017.06 :::

- Top 5% of the major, first-class scholarship three years in a row`,

  "left-right": `# Hana Song | Senior Frontend Engineer

138-0013-8000 · hana@example.com · Chaoyang District, Beijing

## Skills

- **Frameworks**: React, Vue.js, Next.js, Nuxt.js
- **Languages**: TypeScript, JavaScript (ES6+)
- **Tooling**: Webpack, Vite, Rollup, ESLint
- **Performance**: Code splitting, lazy loading

## Experience

:::left
**ByteDance · Senior Frontend Engineer**

Led the frontend architecture of the Douyin Creator Platform and drove its mid-platform rebuild with a team of six.

- Owned technical design for core features, cutting delivery cycle by 30%
- Reworked the build toolchain, CI time down from 8 minutes to 2 minutes
- Established frontend monitoring, production incidents down 45%
:::
:::right
2021.07 – 2024.12
Beijing
:::

:::left
**Tencent · Frontend Engineer**

Owned core modules of the WeChat Mini Program DevTools and developer experience.

- Refactored debugger and compiler modules, startup 40% faster
- Delivered a cross-platform Electron desktop app
:::
:::right
2019.03 – 2021.06
Shenzhen
:::

## Projects

:::left
**Douyin Creator Console · Frontend Lead**

Built the creator analytics and content platform from zero, serving millions of creators.

- Introduced a shared component library, code reuse up to 70%
:::
:::right
2022.06 – 2023.12
:::

## Education

:::left
**Peking University · Computer Science**

Top 5% of the major, first-class scholarship three years in a row.
:::
:::right
2013.09 – 2017.06
:::`,

  timeline: `# Hana Song | Senior Frontend Engineer

138-0013-8000 · hana@example.com · Chaoyang District, Beijing

## Career

### 2021.07 – 2024.12

**ByteDance** —— Senior Frontend Engineer

- Led the frontend architecture of the Douyin Creator Platform with a team of six
- Drove a performance program that cut first paint by 50%

---

### 2019.03 – 2021.06

**Tencent** —— Frontend Engineer

- Built core modules of the WeChat Mini Program DevTools for 100k+ developers
- Shipped a cross-platform Electron desktop app

---

### 2017.07 – 2019.02

**Meituan** —— Frontend Engineer

- Built the merchant admin console and the internal component library

---

## Milestones

### 2022.06 – 2023.12

**Douyin Creator Console** —— Frontend Lead

- React-based analytics and content platform serving millions of creators
- Introduced a shared component library, code reuse up to 70%

---

## Education

### 2013.09 – 2017.06

**Peking University** —— Computer Science

- Top 5% of the major, first-class scholarship three years in a row

## Skills

- React, Vue.js, TypeScript, Next.js, Nuxt.js
- Webpack, Vite, Rollup, monitoring, build governance`,

  minimalist: `# Hana Song

Senior Frontend Engineer · Beijing · 138-0013-8000 · hana@example.com

React · Vue.js · TypeScript · Next.js · Vite · Web Performance

## Experience

### ByteDance · Senior Frontend Engineer

2021.07 – 2024.12

- Led the frontend architecture of the Douyin Creator Platform
- Drove a performance program that cut first paint by 50%

### Tencent · Frontend Engineer

2019.03 – 2021.06

- Built core modules of the WeChat Mini Program DevTools

## Projects

### Douyin Creator Console · Frontend Lead

- React-based analytics and content platform serving millions of creators
- Introduced a shared component library, code reuse up to 70%

## Education

### Peking University · Computer Science

- Top 5% of the major, first-class scholarship three years in a row`,

  elegant: `:::center
# Hana Song
Senior Frontend Engineer · Beijing · 138-0013-8000 · hana@example.com
:::

## Profile

Eight years in frontend engineering, focused on architecture evolution and performance for large-scale B2B platforms. Led technology selection and team building for a product serving millions of creators, with a knack for turning complex business into reusable frontend capabilities.

## Experience

### ByteDance · Senior Frontend Engineer（2021.07 – 2024.12）

- Led the frontend architecture of the Douyin Creator Platform with a team of six
- Drove a performance program that cut first paint by 50% and built monitoring

### Tencent · Frontend Engineer（2019.03 – 2021.06）

- Built core modules of the WeChat Mini Program DevTools for 100k+ developers
- Delivered a cross-platform Electron desktop app

## Education

### Peking University · Computer Science（2013.09 – 2017.06）

- Top 5% of the major, first-class scholarship three years in a row

## Skills

- React, Vue.js, TypeScript, Next.js, Nuxt.js
- Webpack, Vite, Rollup, ESLint, performance monitoring`,

  creative: `# Hana Song

**Senior Frontend Engineer**

138-0013-8000 · hana@example.com · Chaoyang District, Beijing · github.com/hana

> Turning complex business into reusable frontend capabilities——eight years of B2B platform architecture and performance work.

## Projects

### Douyin Creator Console

**Frontend Lead · 2022.06 – 2023.12**

- Built the creator analytics and content platform from zero, now serving **1M+** creators
- Introduced a shared component library, code reuse from 30% up to **70%**
- Cut first paint by **50%**; production incidents down 45% after APM rollout

### Frontend Monitoring SDK

**Creator · 2021.09 – 2022.03**

- Built an error and performance SDK handling **20M+** daily reports
- Wired alerting end to end, mean time to locate dropped from 2 hours to 15 minutes

## Skills

- **Frameworks**: React, Vue.js, Next.js, Nuxt.js
- **Languages**: TypeScript, JavaScript (ES6+)
- **Tooling**: Webpack, Vite, Rollup, Monorepo

## Experience

### ByteDance · Senior Frontend Engineer

2021.07 – 2024.12

### Tencent · Frontend Engineer

2019.03 – 2021.06

## Education

### Peking University · Computer Science

2013.09 – 2017.06`,

  editorial: `# Hana Song

*Senior Frontend Engineer · Beijing*

Eight years in frontend engineering, focused on architecture evolution and performance for large-scale B2B platforms, keeping engineering quality intact while the business ships fast.

138-0013-8000 · hana@example.com · github.com/hana

## Experience

### ByteDance · Senior Frontend Engineer（2021.07 – 2024.12）

Led the frontend architecture of the Douyin Creator Platform, a product serving millions of creators with a team of six. Drove the mid-platform rebuild that cut build time from 8 minutes to 2 minutes, and led a performance program that reduced first paint by 50% while standing up frontend monitoring.

### Tencent · Frontend Engineer（2019.03 – 2021.06）

Owned core modules of the WeChat Mini Program DevTools for over 100k developers, and delivered a cross-platform Electron desktop app across all major systems.

## Projects

### Douyin Creator Console · Frontend Lead（2022.06 – 2023.12）

A React-based analytics and content management platform for creators, where a shared component library lifted code reuse to 70%.

## Education

### Peking University · Computer Science（2013.09 – 2017.06）

Top 5% of the major, with a first-class scholarship three years in a row.

## Skills

React · Vue.js · TypeScript · Next.js · Webpack · Vite · Web Performance`,

  swiss: `# Hana Song | Senior Frontend Engineer

138-0013-8000 · hana@example.com · Chaoyang District, Beijing

## Education

### Peking University · Computer Science

2013.09 – 2017.06 · BSc · Top 5% of the major

## Skills

| Area | Stack |
| --- | --- |
| Frameworks | React, Vue.js, Next.js, Nuxt.js |
| Languages | TypeScript, JavaScript (ES6+) |
| Tooling | Webpack, Vite, Rollup, Monorepo |
| Performance | Code splitting, lazy loading, APM |

## Experience

### ByteDance · Senior Frontend Engineer

2021.07 – 2024.12 · Beijing

- Led the frontend architecture of the Douyin Creator Platform
- Drove a performance program that cut first paint by 50%

### Tencent · Frontend Engineer

2019.03 – 2021.06 · Shenzhen

- Built core modules of the WeChat Mini Program DevTools

## Projects

### Douyin Creator Console · Frontend Lead

2022.06 – 2023.12

- React-based analytics and content platform serving millions of creators`,
};
