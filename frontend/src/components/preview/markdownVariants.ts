import type { ResumeData } from "@/types/resume";
import { getMarkdownTemplate } from "@/config/markdownTemplates";
import type { MarkdownTemplateVariant } from "@/config/markdownTemplates";

/**
 * Markdown 版式变体的样式表。
 *
 * 为什么需要它：Markdown 只有语义（h1/h2/h3/列表），没有版式。
 * 如果所有模板共用一套标题样式，那么换主题色/字号后 9 个模板看起来仍是一模一样的。
 * 因此把「模块标题长什么样」抽象成变体，随 resume.templateId 带走，
 * 既让模板之间真正拉开差异，也保证用户选完模板进编辑器后版式不丢。
 *
 * 每个变体负责三个层面的差异：
 * 1. 简历头部 .resume-header 的样式（顶部色带 / 居中 / 超大姓名等）
 * 2. 模块标题 h2 / 条目小标题 h3 的样式
 * 3. 专业技能区 .mod-skills 的呈现方式（列表 / 标签 / 表格 / 紧凑行）
 */

/** 无 templateId（如匹配结果预览）时使用的变体 = 经典下划线，与历史渲染一致 */
export const DEFAULT_MARKDOWN_VARIANT: MarkdownTemplateVariant = "underline";

/**
 * 解析变体：显式传入优先，其次按简历的 templateId 查模板。
 * 只读显式传入的 resume，不回退到 store 中的 activeResume —— 匹配结果页等
 * 场景展示的是「另一份」简历，不应套用当前编辑中简历的版式。
 */
export const resolveMarkdownVariant = (
  resume?: ResumeData,
  explicit?: MarkdownTemplateVariant
): MarkdownTemplateVariant => {
  if (explicit) return explicit;
  if (!resume?.templateId) return DEFAULT_MARKDOWN_VARIANT;
  return getMarkdownTemplate(resume.templateId).variant;
};

interface VariantTokens {
  themeColor: string;
  headerSize: number;
  subheaderSize: number;
  lineUnit: number;
  moduleSpacing: number;
}

const px = (value: number) => `${Math.round(value)}px`;

/**
 * 每个变体输出 h1/h2/h3、.resume-header、.mod-skills 等规则。
 * 选择器逐行加上 `.resume-markdown-preview[data-preview-id="..."]` 前缀，
 * 保证同一页面多个 MarkdownPreview 实例的样式互不串扰。
 */
const VARIANT_STYLES: Record<
  MarkdownTemplateVariant,
  (t: VariantTokens) => string
> = {
  // 经典：干净专业，姓名左对齐，模块标题用主题色粗下划线
  underline: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 0.8)}; }
    .resume-header h1 { font-size: ${px(headerSize + 6)}; font-weight: 700; color: #111111; line-height: 1.2; margin: 0 0 ${px(lineUnit * 0.2)}; }
    .resume-header p { color: #555555; font-size: 0.95em; }
    h1 { font-size: ${px(headerSize + 6)}; font-weight: 700; color: #111111; line-height: 1.2; }
    h2 { font-size: ${px(headerSize)}; font-weight: 700; color: ${themeColor}; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.2)}; padding-bottom: 4px; border-bottom: 2px solid ${themeColor}; line-height: 1.25; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 600; margin: ${px(lineUnit * 0.25)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills ul { margin: 0; padding-left: 1.4em; }
    .mod-skills li { margin: 0; }`,

  // 商务：顶部深色色带（姓名白字），模块标题深灰 + 浅灰细线，日期右对齐
  split: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { background: #1f2937; color: #ffffff; margin: -${px(lineUnit * 0.75)} -${px(lineUnit * 0.75)} ${px(lineUnit * 0.75)}; padding: ${px(lineUnit * 0.75)} ${px(lineUnit * 0.75)}; border-radius: 0; }
    .resume-header h1 { font-size: ${px(headerSize + 6)}; font-weight: 700; color: #ffffff; margin: 0 0 ${px(lineUnit * 0.15)}; line-height: 1.2; }
    .resume-header p { color: #d1d5db; font-size: 0.9em; }
    h1 { font-size: ${px(headerSize + 6)}; font-weight: 700; color: #111111; line-height: 1.2; }
    h2 { font-size: ${px(headerSize)}; font-weight: 700; color: #111111; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.3)}; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; letter-spacing: 0.02em; line-height: 1.3; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 600; color: ${themeColor}; margin: ${px(lineUnit * 0.2)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills ul { margin: 0; padding-left: 1.4em; }
    .mod-skills li { margin: 0; }
    .mod-item-title { color: #374151; }`,

  // 侧栏：模块标题左侧主题色竖条，经历内容左 / 日期右
  rail: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 0.9)}; border-bottom: 1px solid #e5e7eb; padding-bottom: ${px(lineUnit * 0.4)}; }
    .resume-header h1 { font-size: ${px(headerSize + 4)}; font-weight: 700; color: ${themeColor}; margin: 0 0 ${px(lineUnit * 0.15)}; line-height: 1.2; }
    .resume-header p { color: #555555; font-size: 0.95em; }
    h1 { font-size: ${px(headerSize + 4)}; font-weight: 700; color: ${themeColor}; line-height: 1.2; }
    h2 { font-size: ${px(headerSize)}; font-weight: 700; color: ${themeColor}; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.35)}; padding-left: 10px; border-left: 4px solid ${themeColor}; line-height: 1.25; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 700; color: #1a1a1a; margin: ${px(lineUnit * 0.25)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills ul { margin: 0; padding-left: 1.4em; }
    .mod-skills li { margin: 0; }`,

  // 时间轴：日期作小标题并带左侧刻度线，模块标题宽字距
  timeline: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { text-align: left; margin-bottom: ${px(lineUnit * 0.8)}; }
    .resume-header h1 { font-size: ${px(headerSize + 4)}; font-weight: 700; color: #111111; margin: 0 0 ${px(lineUnit * 0.15)}; line-height: 1.2; }
    .resume-header p { color: #555555; font-size: 0.95em; }
    h1 { font-size: ${px(headerSize + 4)}; font-weight: 700; color: #111111; line-height: 1.2; }
    h2 { font-size: ${px(headerSize - 1)}; font-weight: 700; color: ${themeColor}; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.3)}; letter-spacing: 0.06em; line-height: 1.25; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 700; color: ${themeColor}; margin: ${px(lineUnit * 0.3)} 0 ${px(lineUnit * 0.12)}; padding-left: 8px; border-left: 2px solid ${themeColor}; line-height: 1.3; font-variant-numeric: tabular-nums; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; }
    .mod-skills li { display: inline; margin: 0; }
    .mod-skills li:not(:last-child)::after { content: " · "; color: #9ca3af; }`,

  // 极简：小号宽字距标题 + 发丝线，技能一行收尾
  air: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 1.2)}; }
    .resume-header h1 { font-size: ${px(headerSize + 2)}; font-weight: 600; color: #111111; letter-spacing: 0.06em; margin: 0 0 ${px(lineUnit * 0.2)}; line-height: 1.3; }
    .resume-header p { color: #6b7280; font-size: 0.9em; letter-spacing: 0.03em; }
    h1 { font-size: ${px(headerSize + 2)}; font-weight: 600; color: #111111; letter-spacing: 0.1em; line-height: 1.3; }
    h2 { font-size: 13px; font-weight: 600; color: ${themeColor}; text-transform: uppercase; letter-spacing: 0.18em; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.35)}; padding-bottom: 6px; border-bottom: 1px solid #f0f0f0; line-height: 1.4; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 600; color: #1a1a1a; margin: ${px(lineUnit * 0.25)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; }
    .mod-skills li { display: inline; margin: 0; }
    .mod-skills li:not(:last-child)::after { content: " · "; color: #d1d5db; }`,

  // 优雅：居中姓名与标题，细下划线，衬线气质
  centered: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { text-align: center; margin-bottom: ${px(lineUnit * 1)}; }
    .resume-header h1 { font-size: ${px(headerSize + 8)}; font-weight: 400; color: #111111; margin: 0 0 ${px(lineUnit * 0.2)}; line-height: 1.25; letter-spacing: 0.02em; }
    .resume-header p { color: #6b7280; font-size: 0.95em; }
    .md-align-center .resume-header { margin-bottom: 0; }
    .md-align-center { text-align: center; margin-bottom: ${px(lineUnit * 1)}; }
    .md-align-center h1 { font-size: ${px(headerSize + 8)}; font-weight: 400; color: #111111; margin: 0 0 ${px(lineUnit * 0.2)}; line-height: 1.25; letter-spacing: 0.02em; }
    .md-align-center p { color: #6b7280; font-size: 0.95em; }
    h1 { font-size: ${px(headerSize + 6)}; font-weight: 400; color: #111111; text-align: center; line-height: 1.25; }
    h2 { font-size: ${px(headerSize)}; font-weight: 700; color: ${themeColor}; text-align: center; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.35)}; padding-bottom: 6px; border-bottom: 1px solid ${themeColor}; line-height: 1.3; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 600; color: #1a1a1a; margin: ${px(lineUnit * 0.25)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills { text-align: center; }
    .mod-skills h2 { display: inline-block; padding-left: ${px(lineUnit)}; padding-right: ${px(lineUnit)}; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; display: inline-flex; flex-wrap: wrap; justify-content: center; gap: 6px 12px; }
    .mod-skills li { margin: 0; }`,

  // 创意：模块标题为主题色色块，姓名超大加粗，技能做成标签
  band: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 0.7)}; }
    .resume-header h1 { font-size: ${px(headerSize + 12)}; font-weight: 800; color: #111111; margin: 0 0 ${px(lineUnit * 0.1)}; line-height: 1.1; }
    .resume-header p { color: #4b5563; font-size: 0.95em; }
    h1 { font-size: ${px(headerSize + 8)}; font-weight: 800; color: #111111; line-height: 1.15; }
    h2 { font-size: ${px(headerSize - 2)}; font-weight: 700; color: #ffffff; background: ${themeColor}; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.35)}; padding: 4px 10px; border-radius: 3px; letter-spacing: 0.02em; line-height: 1.5; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 700; color: #1a1a1a; margin: ${px(lineUnit * 0.3)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px 8px; }
    .mod-skills li { margin: 0; background: #f3f4f6; color: #374151; padding: 2px 8px; border-radius: 3px; font-size: 0.92em; }
    .mod-skills li strong { color: #111111; }`,

  // 画报：超大衬线姓名，模块标题无边框仅靠字号与主题色区分
  editorial: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 0.9)}; }
    .resume-header h1 { font-size: ${px(headerSize + 18)}; font-weight: 700; color: #111111; margin: 0 0 ${px(lineUnit * 0.1)}; line-height: 1.05; letter-spacing: -0.02em; }
    .resume-header p { color: #6b7280; font-size: 0.95em; }
    .resume-header p em, .resume-header p i { color: ${themeColor}; font-style: normal; }
    h1 { font-size: ${px(headerSize + 14)}; font-weight: 700; color: #111111; line-height: 1.1; letter-spacing: -0.01em; }
    h2 { font-size: ${px(headerSize + 2)}; font-weight: 700; color: ${themeColor}; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.3)}; padding: 0; border: 0; line-height: 1.2; }
    h3 { font-size: ${px(subheaderSize + 1)}; font-weight: 700; color: #1a1a1a; margin: ${px(lineUnit * 0.3)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills { margin-top: ${px(lineUnit * 0.5)}; }
    .mod-skills h2 { font-size: ${px(headerSize)}; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; }
    .mod-skills li { display: inline; margin: 0; }
    .mod-skills li:not(:last-child)::after { content: " · "; color: #9ca3af; }`,

  // 瑞士：模块标题上方粗线 + 小号宽字距，教育与表格化技能前置
  rule: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 0.9)}; padding-bottom: ${px(lineUnit * 0.4)}; border-bottom: 1px solid #e5e7eb; }
    .resume-header h1 { font-size: ${px(headerSize + 4)}; font-weight: 700; color: #111111; margin: 0 0 ${px(lineUnit * 0.15)}; line-height: 1.2; }
    .resume-header p { color: #555555; font-size: 0.95em; }
    h1 { font-size: ${px(headerSize + 2)}; font-weight: 700; color: #111111; line-height: 1.2; letter-spacing: -0.01em; }
    h2 { font-size: 13px; font-weight: 700; color: ${themeColor}; text-transform: uppercase; letter-spacing: 0.1em; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.3)}; padding-top: 8px; border-top: 4px solid ${themeColor}; line-height: 1.4; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 700; color: #1a1a1a; margin: ${px(lineUnit * 0.25)} 0 ${px(lineUnit * 0.1)}; line-height: 1.35; }
    .mod-skills table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
    .mod-skills th { text-align: left; font-weight: 700; color: ${themeColor}; border-bottom: 2px solid ${themeColor}; padding: 4px 8px 4px 0; }
    .mod-skills td { padding: 4px 8px 4px 0; border-bottom: 1px solid #e5e7eb; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 16px; }
    .mod-skills li { margin: 0; padding-left: 10px; position: relative; }
    .mod-skills li::before { content: ""; position: absolute; left: 0; top: 0.55em; width: 4px; height: 4px; background: ${themeColor}; border-radius: 50%; }`,

  // 成果账本：以量化成果为主角，顶部定位句 + 细密横线 + 紧凑项目条目
  impact: ({ themeColor, headerSize, subheaderSize, lineUnit, moduleSpacing }) => `
    .resume-header { margin-bottom: ${px(lineUnit * 0.9)}; padding-bottom: ${px(lineUnit * 0.55)}; border-bottom: 2px solid ${themeColor}; }
    .resume-header h1 { font-size: ${px(headerSize + 8)}; font-weight: 800; color: #111111; margin: 0 0 ${px(lineUnit * 0.15)}; line-height: 1.1; letter-spacing: -0.02em; }
    .resume-header p { color: #4b5563; font-size: 0.92em; }
    h1 { font-size: ${px(headerSize + 6)}; font-weight: 800; color: #111111; line-height: 1.15; letter-spacing: -0.01em; }
    h2 { display: flex; align-items: baseline; gap: 10px; font-size: 12px; font-weight: 700; color: ${themeColor}; text-transform: uppercase; letter-spacing: 0.14em; margin: ${px(moduleSpacing)} 0 ${px(lineUnit * 0.3)}; padding-bottom: 6px; border-bottom: 1px solid #d1d5db; line-height: 1.4; }
    h2::after { flex: 1; height: 1px; background: #e5e7eb; content: ""; }
    h3 { font-size: ${px(subheaderSize)}; font-weight: 750; color: #111111; margin: ${px(lineUnit * 0.28)} 0 ${px(lineUnit * 0.1)}; line-height: 1.3; }
    .mod-item-title { color: ${themeColor}; }
    .mod-skills ul { margin: 0; padding-left: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; }
    .mod-skills li { margin: 0; color: #374151; }
    .mod-skills li::before { content: "—"; color: ${themeColor}; margin-right: 5px; }`,
};

const scopeToPreview = (css: string, scopeSelector?: string): string => {
  const prefix = scopeSelector
    ? `${scopeSelector} `
    : ".resume-markdown-preview ";
  return css
    .split("\n")
    .map((line) => {
      const rule = line.trim();
      return rule ? `${prefix}${rule}` : "";
    })
    .join("\n");
};

export const buildVariantCss = (
  variant: MarkdownTemplateVariant,
  tokens: VariantTokens,
  scopeSelector?: string
): string => scopeToPreview(VARIANT_STYLES[variant](tokens), scopeSelector);
