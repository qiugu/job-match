import type { GlobalSettings, ResumeData, ThemeColor } from "@/types/resume";
import { THEME_COLORS } from "@/types/resume";
import { DEFAULT_FONT_FAMILY } from "@/utils/fonts";
import { blankResumeState, blankResumeStateEn } from "@/config/initialResumeData";
import { MARKDOWN_SAMPLE_EN, MARKDOWN_SAMPLE_ZH } from "./samples";

/**
 * Markdown 模板体系（简历模板页 /app/dashboard/templates 的数据源）。
 *
 * 背景：编辑器的唯一内容源已是 markdownContent（见 MarkdownWorkbench / ResumeCardItem），
 * 模板页却仍在用结构化 ResumeData 渲染 9 套 React 模板组件，导致「选模板 → 进编辑器」
 * 之后样式与预览完全对不上。这里把模板改成「示例 Markdown + 排版设置」，
 * 预览与创建都走 MarkdownPreview，保证所见即所得。
 *
 * 主题色：模板默认色只允许取 THEME_COLORS（types/resume.ts）中的值，
 * 与编辑器（SidePanel / MarkdownWorkbench）的主题色色板同源，避免两套色板不一致。
 */
/** 模板排版设置：themeColor 必填且必须是预设色板之一 */
export type MarkdownTemplateSettings = GlobalSettings & {
  themeColor: ThemeColor;
};

/**
 * Markdown 版式变体：决定模块标题 / 姓名标题 / 条目小标题的实际渲染样式。
 *
 * 光靠改主题色和字号不足以区分模板（那样 9 个模板会长得一模一样），
 * 因此每个变体在 MarkdownPreview 里对应一套标题排版规则：
 * 下划线 / 细线 / 左侧色条 / 时间轴刻度 / 宽字距小标题 / 居中 / 色块 / 超大衬线 / 顶部粗线。
 * 变体与模板一一对应，随 resume.templateId 持久化，进编辑器后版式不丢。
 */
export type MarkdownTemplateVariant =
  | "underline" // 经典：模块标题主题色 + 底部粗下划线
  | "split" // 商务：深色标题 + 浅灰细线，条目左右分布
  | "rail" // 侧栏：模块标题左侧主题色竖条
  | "timeline" // 时间轴：日期作小标题并带左侧刻度线
  | "air" // 极简：小号宽字距标题 + 发丝线
  | "centered" // 优雅：居中标题 + 细下划线
  | "band" // 创意：模块标题为主题色色块
  | "editorial" // 画报：超大衬线标题，无边框
  | "rule"; // 瑞士：上方粗线 + 小号宽字距标题

export interface MarkdownTemplate {
  /**
   * 与结构化模板 registry（components/templates/registry.ts）保持同一套 id，
   * 这样历史简历里的 templateId 仍然可解析，不需要数据迁移。
   */
  id: string;
  /**
   * i18n key 后缀：dashboard.templates.<nameKey>.name / .description。
   * 注意 left-right 的 key 是 leftRight（沿用原有 i18n 结构）。
   */
  nameKey: string;
  /** 模板默认主题色：必须是 THEME_COLORS 之一 */
  themeColor: ThemeColor;
  /** 版式变体：决定模块标题等渲染样式，是模板之间真正的视觉差异 */
  variant: MarkdownTemplateVariant;
  /** 模板默认排版设置，创建/预览时合并进 resume.globalSettings */
  globalSettings: MarkdownTemplateSettings;
  /** 示例正文（中文） */
  markdown: string;
  /** 示例正文（英文） */
  markdownEn: string;
}

// 字体：与 utils/fonts.ts 的 FONT_DEFINITIONS 保持一致的取值，
// 传给 MarkdownPreview 时会经 normalizeFontFamily 归一化。
const FONT_SANS = DEFAULT_FONT_FAMILY;
const FONT_MISANS = '"MiSans", sans-serif';
const FONT_NOTO = '"Noto Sans SC", "Noto Sans CJK SC", sans-serif';
const FONT_SERIF = '"Source Han Serif SC", "Noto Serif SC", serif';

const buildTemplate = (
  id: string,
  nameKey: string,
  themeColor: ThemeColor,
  variant: MarkdownTemplateVariant,
  globalSettings: Omit<MarkdownTemplateSettings, "themeColor">
): MarkdownTemplate => ({
  id,
  nameKey,
  themeColor,
  variant,
  globalSettings: { ...globalSettings, themeColor },
  markdown: MARKDOWN_SAMPLE_ZH[id] ?? "",
  markdownEn: MARKDOWN_SAMPLE_EN[id] ?? "",
});

export const MARKDOWN_TEMPLATES: MarkdownTemplate[] = [
  // 经典：完整四模块（技能→经历→项目→教育），主题色下划线标题
  buildTemplate("classic", "classic", THEME_COLORS[0], "underline", {
    fontFamily: FONT_SANS,
    baseFontSize: 15,
    lineHeight: 1.6,
    pagePadding: 36,
    sectionSpacing: 14,
    headerSize: 18,
    subheaderSize: 15,
  }),
  // 商务：经历优先（经历→项目→技能→教育），公司左 / 日期右
  buildTemplate("modern", "modern", THEME_COLORS[2], "split", {
    fontFamily: FONT_NOTO,
    baseFontSize: 14,
    lineHeight: 1.55,
    pagePadding: 32,
    sectionSpacing: 12,
    headerSize: 17,
    subheaderSize: 14,
  }),
  // 侧栏日期：经历详写型，左内容块 + 右日期栏，标题带左侧竖条
  buildTemplate("left-right", "leftRight", THEME_COLORS[1], "rail", {
    fontFamily: FONT_MISANS,
    baseFontSize: 14,
    lineHeight: 1.6,
    pagePadding: 34,
    sectionSpacing: 16,
    headerSize: 17,
    subheaderSize: 14,
  }),
  // 时间轴：三段履历按时间倒序，日期作小标题带刻度线，技能置于末尾
  buildTemplate("timeline", "timeline", THEME_COLORS[6], "timeline", {
    fontFamily: FONT_SANS,
    baseFontSize: 15,
    lineHeight: 1.65,
    pagePadding: 36,
    sectionSpacing: 16,
    headerSize: 18,
    subheaderSize: 15,
  }),
  // 极简：只保留三个模块，技能压缩成一行，宽字距小标题 + 大留白
  buildTemplate("minimalist", "minimalist", THEME_COLORS[0], "air", {
    fontFamily: FONT_SANS,
    baseFontSize: 14,
    lineHeight: 1.8,
    pagePadding: 48,
    sectionSpacing: 24,
    headerSize: 16,
    subheaderSize: 14,
  }),
  // 优雅：居中头部 + 居中标题，开篇个人简述段落，衬线字体
  buildTemplate("elegant", "elegant", THEME_COLORS[3], "centered", {
    fontFamily: FONT_SERIF,
    baseFontSize: 15,
    lineHeight: 1.7,
    pagePadding: 40,
    sectionSpacing: 18,
    headerSize: 17,
    subheaderSize: 15,
  }),
  // 创意：项目优先，成果数据化，模块标题为主题色色块
  buildTemplate("creative", "creative", THEME_COLORS[4], "band", {
    fontFamily: FONT_SANS,
    baseFontSize: 15,
    lineHeight: 1.6,
    pagePadding: 32,
    sectionSpacing: 18,
    headerSize: 22,
    subheaderSize: 17,
  }),
  // 画报：超大衬线姓名 + 导语段落，正文段落化叙述不用列表
  buildTemplate("editorial", "editorial", THEME_COLORS[5], "editorial", {
    fontFamily: FONT_SERIF,
    baseFontSize: 14,
    lineHeight: 1.75,
    pagePadding: 28,
    sectionSpacing: 20,
    headerSize: 22,
    subheaderSize: 16,
  }),
  // 瑞士：教育 + 表格化技能前置，日期左置，顶部粗线小标题
  buildTemplate("swiss", "swiss", THEME_COLORS[0], "rule", {
    fontFamily: FONT_SANS,
    baseFontSize: 14,
    lineHeight: 1.45,
    pagePadding: 40,
    sectionSpacing: 20,
    headerSize: 18,
    subheaderSize: 14,
  }),
];

/** 兜底模板：id 无法匹配时（历史脏数据）回退到第一个 */
export const DEFAULT_MARKDOWN_TEMPLATE = MARKDOWN_TEMPLATES[0];

export const getMarkdownTemplate = (
  templateId?: string | null
): MarkdownTemplate =>
  MARKDOWN_TEMPLATES.find((template) => template.id === templateId) ??
  DEFAULT_MARKDOWN_TEMPLATE;

/** 按语言取模板示例正文 */
export const getMarkdownTemplateContent = (
  template: MarkdownTemplate,
  locale: string
): string => (locale === "en" ? template.markdownEn : template.markdown);

/**
 * 构造一份「模板预览用」的简历数据。
 * MarkdownPreview 通过 resume.globalSettings 读取主题色/字号/行高/页边距，
 * 因此模板的样式差异全部落在 globalSettings 上，不需要额外的渲染分支。
 *
 * @param template 目标模板
 * @param locale   语言（zh / en），决定示例正文
 * @param themeColor 用户选择的主题色；传空字符串表示「跟随模板默认色」
 */
export const buildMarkdownTemplateResume = (
  template: MarkdownTemplate,
  locale: string,
  themeColor?: string
): ResumeData => {
  const base = locale === "en" ? blankResumeStateEn : blankResumeState;

  return {
    ...(base as unknown as ResumeData),
    id: `markdown-template-${template.id}`,
    templateId: template.id,
    markdownContent: getMarkdownTemplateContent(template, locale),
    globalSettings: {
      ...base.globalSettings,
      ...template.globalSettings,
      themeColor: themeColor || template.themeColor,
    },
  } as ResumeData;
};
