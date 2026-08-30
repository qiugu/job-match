import { generateUUID } from "@/utils/uuid";
import { initialResumeState } from "@/config/initialResumeData";
import { MARKDOWN_TEMPLATES } from "@/config";

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const toString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export const toStringArray = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => toString(item))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean);
  }

  return [] as string[];
};

export const toListHtml = (value: unknown) => {
  const items = toStringArray(value);
  if (items.length === 0) return "";
  return `<ul>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
};

export const extractJsonContent = (content: string) => {
  const direct = content.trim();
  try {
    return JSON.parse(direct);
  } catch (error) { }

  const fencedMatch = direct.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch (error) { }
  }

  const objectMatch = direct.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (error) { }
  }

  throw new Error("Invalid AI JSON content");
};

/**
 * 把后端返回的 PDF 版式元数据（layout）映射为本应用的 GlobalSettings，
 * 让导入后的简历在字体 / 字号 / 间距 / 分页上尽量贴近原 PDF。
 */
const buildLayoutSettings = (layout: any): {
  templateId: string | null;
  globalSettings: Record<string, any>;
} => {
  if (!layout || typeof layout !== "object") {
    return { templateId: MARKDOWN_TEMPLATES[0]?.id ?? null, globalSettings: {} };
  }

  const baseFontSize = typeof layout.fontSize === "number" && layout.fontSize > 0
    ? Math.min(18, Math.max(10, Math.round(layout.fontSize)))
    : undefined;
  const pagePadding = typeof layout.pagePadding === "number" && layout.pagePadding > 0
    ? Math.min(64, Math.max(12, Math.round(layout.pagePadding)))
    : undefined;

  const globalSettings: Record<string, any> = {};
  if (layout.fontFamily) globalSettings.fontFamily = layout.fontFamily;
  if (baseFontSize) {
    globalSettings.baseFontSize = baseFontSize;
    // 标题/小标题字号按主字号等比推导，避免整体比例失调
    globalSettings.headerSize = Math.min(28, Math.round(baseFontSize * 1.4));
    globalSettings.subheaderSize = Math.min(20, Math.round(baseFontSize * 1.15));
  }
  if (pagePadding) globalSettings.pagePadding = pagePadding;
  if (layout.themeColor) globalSettings.themeColor = layout.themeColor;
  // 行高：中文简历偏紧凑，给 1.5~1.6 的稳妥默认值
  globalSettings.lineHeight = 1.55;
  globalSettings.paragraphSpacing = baseFontSize ? Math.round(baseFontSize * 0.6) : 10;
  globalSettings.sectionSpacing = baseFontSize ? Math.round(baseFontSize * 0.9) : 14;

  // 模板选择：统一使用默认（经典）模板。
  // 原来双栏 PDF 会选 left-right，但 Markdown 渲染并不支持真双栏，
  // 而 templateId 现在决定的是版式变体（模块标题样式），沿用 left-right
  // 只会让导入的简历平白套上「侧栏日期」的标题样式，因此统一回落到经典版式。
  return { templateId: MARKDOWN_TEMPLATES[0]?.id ?? null, globalSettings };
};

/**
 * 把结构化简历数据序列化为 Markdown 文本。
 * 当前编辑器（MarkdownWorkbench）与缩略图（ResumeCardItem）均以 markdownContent
 * 为唯一内容源，因此导入 PDF 得到的结构化数据必须回填 markdownContent，
 * 否则编辑区为空、缩略图回退到结构化模板渲染导致显示异常。
 */
const buildMarkdownContent = (parts: {
  topTitle: string;
  basic: any;
  education: any[];
  experience: any[];
  projects: any[];
  skillSource: any;
}) => {
  const lines: string[] = [];
  const { topTitle, basic, education, experience, projects, skillSource } = parts;

  // 标题：姓名 | 求职方向（求职方向优先取顶层 title，回退 basic.title）
  const name = toString(basic?.name);
  const title = topTitle || toString(basic?.title);
  if (name || title) {
    lines.push(`# ${[name, title].filter(Boolean).join(" | ")}`);
  }

  // 基本信息行（联系方式）
  const contacts = [
    toString(basic?.phone),
    toString(basic?.email),
    toString(basic?.location),
    toString(basic?.employementStatus),
  ].filter(Boolean);
  if (contacts.length > 0) {
    lines.push(contacts.join(" · "));
  }

  // 专业技能：识别 "分类：技能列表" 形态聚合成一行（保留原 PDF 的分组结构）
  const skills = toStringArray(skillSource);
  if (skills.length > 0) {
    lines.push("", "## 专业技能");
    const groupedSkills: string[] = [];
    const groupSep = /[:：]/;
    skills.forEach((s) => {
      const idx = s.search(groupSep);
      if (idx > 0 && idx < s.length - 1) {
        // 已有相同分类则合并到右侧，否则新建分组行
        const cat = s.slice(0, idx).trim();
        const rest = s.slice(idx + 1).trim();
        const last = groupedSkills[groupedSkills.length - 1];
        if (last && last.startsWith(cat + groupSep.source)) {
          groupedSkills[groupedSkills.length - 1] =
            last.replace(groupSep, "：") + "，" + rest;
        } else {
          groupedSkills.push(`${cat}：${rest}`);
        }
      } else {
        groupedSkills.push(s);
      }
    });
    groupedSkills.forEach((s) => lines.push(`- ${s}`));
  }

  // 工作经历
  if (experience.length > 0) {
    lines.push("", "## 工作经历");
    experience.forEach((item) => {
      const company = toString(item?.company);
      const position = toString(item?.position);
      const date = toString(item?.date);
      const head = [position, company].filter(Boolean).join(" · ");
      if (head) lines.push("", `### ${head}${date ? `（${date}）` : ""}`);
      else if (date) lines.push("", `### ${date}`);
      toStringArray(item?.details ?? item?.description).forEach((d) =>
        lines.push(`- ${d}`)
      );
    });
  }

  // 项目经历
  if (projects.length > 0) {
    lines.push("", "## 项目经历");
    projects.forEach((item) => {
      const name2 = toString(item?.name);
      const role = toString(item?.role);
      const date = toString(item?.date);
      const head = [name2, role].filter(Boolean).join(" · ");
      if (head) lines.push("", `### ${head}${date ? `（${date}）` : ""}`);
      else if (date) lines.push("", `### ${date}`);
      toStringArray(item?.description ?? item?.details).forEach((d) =>
        lines.push(`- ${d}`)
      );
    });
  }

  // 教育经历
  if (education.length > 0) {
    lines.push("", "## 教育经历");
    education.forEach((item) => {
      const school = toString(item?.school);
      const major = toString(item?.major);
      const degree = toString(item?.degree);
      const date = [toString(item?.startDate), toString(item?.endDate)]
        .filter(Boolean)
        .join(" - ");
      const head = [school, [major, degree].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
      if (head) lines.push("", `### ${head}${date ? `（${date}）` : ""}`);
      else if (date) lines.push("", `### ${date}`);
      toStringArray(item?.description).forEach((d) => lines.push(`- ${d}`));
    });
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

export const createResumeFromAIResult = (result: any, fileName: string) => {
  const now = new Date().toISOString();
  const id = generateUUID();

  const education = Array.isArray(result?.education) ? result.education : [];
  const experience = Array.isArray(result?.experience) ? result.experience : [];
  const projects = Array.isArray(result?.projects) ? result.projects : [];

  // LLM 契约中技能是顶层数组 skills[]，优先取它（skillContent 为历史兼容字段）
  const skillSource = result?.skills ?? result?.skillContent;
  const skillContent = toListHtml(skillSource);

  // 缩略图与编辑器均以 markdownContent 为内容源：从结构化数据回填 Markdown
  const markdownContent = buildMarkdownContent({
    topTitle: toString(result?.title),
    basic: result?.basic,
    education,
    experience,
    projects,
    skillSource,
  });

  // 用 PDF 版式元数据推导模板与样式，使导入结果贴近源文件
  const { templateId, globalSettings } = buildLayoutSettings(result?.layout);

  return {
    ...initialResumeState,
    id,
    title: toString(result?.title) || fileName || `Imported Resume ${id.slice(0, 6)}`,
    createdAt: now,
    updatedAt: now,
    templateId,
    globalSettings: {
      ...initialResumeState.globalSettings,
      ...globalSettings,
    },
    basic: {
      ...initialResumeState.basic,
      name: toString(result?.basic?.name),
      title: toString(result?.basic?.title),
      email: toString(result?.basic?.email),
      phone: toString(result?.basic?.phone),
      location: toString(result?.basic?.location),
      employementStatus: toString(result?.basic?.employementStatus),
      birthDate: toString(result?.basic?.birthDate),
      customFields: [],
      photo: "",
      githubKey: "",
      githubUseName: "",
      githubContributionsVisible: false,
    },
    education: education
      .map((item: any) => ({
        id: generateUUID(),
        school: toString(item?.school),
        major: toString(item?.major),
        degree: toString(item?.degree),
        startDate: toString(item?.startDate),
        endDate: toString(item?.endDate),
        gpa: toString(item?.gpa),
        description: toListHtml(item?.description),
        visible: true,
      }))
      .filter((item: any) => item.school || item.major || item.degree),
    experience: experience
      .map((item: any) => ({
        id: generateUUID(),
        company: toString(item?.company),
        position: toString(item?.position),
        date: toString(item?.date),
        details: toListHtml(item?.details || item?.description),
        visible: true,
      }))
      .filter((item: any) => item.company || item.position || item.date || item.details),
    projects: projects
      .map((item: any) => ({
        id: generateUUID(),
        name: toString(item?.name),
        role: toString(item?.role),
        date: toString(item?.date),
        description: toListHtml(item?.description || item?.details),
        link: toString(item?.link),
        linkLabel: toString(
          item?.linkLabel ??
            item?.linkText ??
            item?.displayText ??
            item?.linkDisplayText
        ),
        visible: true,
      }))
      .filter((item: any) => item.name || item.role || item.date || item.description),
    skillContent,
    markdownContent,
    customData: {},
  };
};
