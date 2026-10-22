export interface PhotoConfig {
  width: number;
  height: number;
  aspectRatio: "1:1" | "4:3" | "3:4" | "16:9" | "custom";
  borderRadius: "none" | "medium" | "full" | "custom";
  customBorderRadius: number;
  visible?: boolean;
}

export const DEFAULT_CONFIG: PhotoConfig = {
  width: 90,
  height: 120,
  aspectRatio: "1:1",
  borderRadius: "none",
  customBorderRadius: 0,
  visible: true,
};

export const getRatioMultiplier = (ratio: PhotoConfig["aspectRatio"]) => {
  switch (ratio) {
    case "4:3":
      return 3 / 4;
    case "3:4":
      return 4 / 3;
    case "16:9":
      return 9 / 16;
    default:
      return 1;
  }
};

export const getBorderRadiusValue = (config?: PhotoConfig) => {
  if (!config) return "0";

  switch (config.borderRadius) {
    case "medium":
      return "0.5rem";
    case "full":
      return "9999px";
    case "custom":
      return `${config.customBorderRadius}px`;
    default:
      return "0";
  }
};

export interface BasicFieldType {
  id: string;
  key: keyof BasicInfo;
  label: string;
  type?: "date" | "textarea" | "text" | "editor";
  visible: boolean;
  custom?: boolean;
}

export interface CustomFieldType {
  id: string;
  label: string;
  value: string;
  icon?: string;
  visible?: boolean;
  custom?: boolean;
  displayLabel?: boolean;
}
export interface BasicInfo {
  birthDate: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  location: string;
  icons: Record<string, string>;
  employementStatus: string;
  photo: string;
  photoConfig: PhotoConfig;
  fieldOrder?: BasicFieldType[];
  customFields: CustomFieldType[];
  githubKey: string;
  githubUseName: string;
  githubContributionsVisible: boolean;
  layout?: "left" | "center" | "right";
}

export interface Education {
  id: string;
  school: string;
  major: string;
  degree: string;
  startDate: string;
  endDate: string;
  gpa?: string;
  description?: string;
  visible?: boolean;
}

export interface Experience {
  id: string;
  company: string;
  position: string;
  date: string;
  details: string;
  visible?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  level: number;
}

export interface Project {
  id: string;
  name: string;
  role: string;
  date: string;
  description: string;
  visible: boolean;
  link?: string;
  linkLabel?: string;
}

export interface Certificate {
  id: string;
  url: string; // Base64 encoding for the image or direct URL
  width: number; // Width percentage to support flex layouts
}

export type GlobalSettings = {
  themeColor?: string | undefined;
  fontFamily?: string | undefined;
  baseFontSize?: number | undefined;
  pagePadding?: number | undefined;
  paragraphSpacing?: number | undefined;
  lineHeight?: number | undefined;
  sectionSpacing?: number | undefined;
  headerSize?: number | undefined;
  subheaderSize?: number | undefined;
  useIconMode?: boolean | undefined;
  centerSubtitle?: boolean | undefined;
  flexibleHeaderLayout?: boolean | undefined;
};

/**
 * 页面边距（px）默认值 —— 全站单一事实源。
 * 取值依据：A4 实纸 @96dpi 下 1px = 0.2646mm，48px = 12.7mm = 0.5 inch，
 * 恰为简历排版通行下限（主流职业指南均要求 ≥ 0.5″，常规推荐 0.75–1″）。
 * 曾为 32px（0.33″，低于下限，观感贴边），2026-09-09 修正并统一为 48px。
 * 消费方（PDF 导出 / 浏览器打印 / 分页计算 / 模板渲染）在字段缺失时
 * 必须回退到本常量，禁止再各自硬编码 0 或 32/48。
 */
export const DEFAULT_PAGE_PADDING = 48;

export interface ResumeTheme {
  id: string;
  name: string;
  color: string;
}

export interface CustomItem {
  id: string;
  title: string;
  subtitle: string;
  dateRange: string;
  description: string;
  visible: boolean;
}

/**
 * 主题色预设色板：编辑器（SidePanel / MarkdownWorkbench）与简历模板页共用这一份，
 * 避免两处各自定义导致「模板页选的颜色进编辑器后变色」。
 * 用 as const 固化字面量类型，模板默认色即可被 ThemeColor 约束，
 * 编译期保证模板不会引入色板之外的颜色。
 */
export const THEME_COLORS = [
  "#1A1A1A", // 墨黑（默认）
  "#0047AB", // 克莱因蓝
  "#2563EB", // 亮蓝
  "#8B0000", // 深红
  "#E8551F", // 橙
  "#4B0082", // 靛紫
  "#2E8B57", // 海绿
] as const;

/** 预设主题色字面量联合类型 */
export type ThemeColor = (typeof THEME_COLORS)[number];

export interface MenuSection {
  id: string;
  title: string;
  icon: string;
  enabled: boolean;
  order: number;
}

export interface ResumeData {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  templateId: string | null | undefined;
  basic: BasicInfo;
  education: Education[];
  experience: Experience[];
  projects: Project[];
  certificates: Certificate[];
  customData: Record<string, CustomItem[]>;
  skillContent: string;
  selfEvaluationContent: string;
  markdownContent?: string;
  activeSection: string;
  draggingProjectId: string | null;
  menuSections: MenuSection[];
  globalSettings: GlobalSettings;
}

export interface ResumeStore {
  resumes: ResumeData[];
  currentResumeId: string | null;
  currentResume: ResumeData | null;
  addResume: (resume: Omit<ResumeData, "id">) => void;
  updateResume: (id: string, data: Partial<ResumeData>) => void;
  deleteResume: (id: string) => void;
  setCurrentResume: (id: string) => void;
  updateBasicInfo: (info: Partial<ResumeData["basic"]>) => void;
  addEducation: (education: Omit<ResumeData["education"][0], "id">) => void;
  updateEducation: (
    educationId: string,
    data: Partial<ResumeData["education"][0]>
  ) => void;
  removeEducation: (educationId: string) => void;
  addExperience: (experience: Omit<ResumeData["experience"][0], "id">) => void;
  updateExperience: (
    experienceId: string,
    data: Partial<ResumeData["experience"][0]>
  ) => void;
  removeExperience: (experienceId: string) => void;
  updateSkillContent: (skillContent: string) => void;
  addCertificate: (certificate: Certificate) => void;
  updateCertificate: (id: string, updates: Partial<Certificate>) => void;
  updateCertificatesBatch: (certificates: Certificate[]) => void;
  removeCertificate: (id: string) => void;
}
