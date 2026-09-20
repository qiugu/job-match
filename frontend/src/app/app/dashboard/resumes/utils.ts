import { blankResumeState } from "@/config/initialResumeData";
import type { ResumeData } from "@/types/resume";
import { generateUUID } from "@/utils/uuid";

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const toString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/**
 * 将后端返回的描述行原样转成 markdown 行。
 * 列表、标题和普通段落的结构由数据来源决定，前端不再猜测或补圆点。
 */
export function renderDescriptionRows(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function cloneBlankResume(): ResumeData {
  return JSON.parse(JSON.stringify(blankResumeState)) as ResumeData;
}

function dateRange(startDate?: string, endDate?: string): string {
  const start = toString(startDate);
  const end = toString(endDate);
  if (!start && !end) return "";
  return `${start} - ${end}`.trim();
}

function buildMarkdownContent(result: any): string {
  const basic = result?.basic ?? {};
  const lines: string[] = [];
  const name = toString(basic.name);
  const title = toString(basic.title);
  if (name || title) lines.push(`# ${[name, title].filter(Boolean).join(" | ")}`);

  if (result?.skills) {
    lines.push("", "## 专业技能");
    lines.push(...renderDescriptionRows(result.skills));
  }
  if (Array.isArray(result?.experience) && result.experience.length) {
    lines.push("", "## 工作经历");
    for (const item of result.experience) {
      const heading = [toString(item.company), toString(item.position), toString(item.date)]
        .filter(Boolean)
        .join(" · ");
      if (heading) lines.push(`### ${heading}`);
      lines.push(...renderDescriptionRows(item.details));
    }
  }
  if (Array.isArray(result?.projects) && result.projects.length) {
    lines.push("", "## 项目经历");
    for (const item of result.projects) {
      const heading = [toString(item.name), toString(item.role), toString(item.date)]
        .filter(Boolean)
        .join(" · ");
      if (heading) lines.push(`### ${heading}`);
      lines.push(...renderDescriptionRows(item.description));
    }
  }
  if (Array.isArray(result?.education) && result.education.length) {
    lines.push("", "## 教育经历");
    for (const item of result.education) {
      const school = toString(item.school);
      const major = toString(item.major);
      const degree = toString(item.degree);
      const range = dateRange(item.startDate, item.endDate);
      const suffix = [degree, range ? `（${range}）` : ""].filter(Boolean).join("");
      const heading = [school, major].filter(Boolean).join(" · ") + (suffix ? ` ${suffix}` : "");
      if (heading.trim()) lines.push(`### ${heading.trim()}`);
      lines.push(...renderDescriptionRows(item.description));
    }
  }
  return lines.join("\n").trim();
}

/** 将 AI/导入接口的简化结构映射为编辑器使用的 ResumeData。 */
export function createResumeFromAIResult(result: any, filename = ""): ResumeData {
  const now = new Date().toISOString();
  const resume = cloneBlankResume();
  const basic = result?.basic ?? {};
  const title = toString(result?.title) || filename.replace(/\.pdf$/i, "") || "新建简历";

  resume.id = generateUUID();
  resume.title = title;
  resume.createdAt = now;
  resume.updatedAt = now;
  resume.basic = {
    ...resume.basic,
    name: toString(basic.name),
    title: toString(basic.title),
    email: toString(basic.email),
    phone: toString(basic.phone),
    location: toString(basic.location),
    birthDate: toString(basic.birthDate),
    employementStatus: toString(basic.employementStatus),
  };
  resume.education = (Array.isArray(result?.education) ? result.education : []).map((item: any) => ({
    id: toString(item.id) || generateUUID(),
    school: toString(item.school),
    major: toString(item.major),
    degree: toString(item.degree),
    startDate: toString(item.startDate),
    endDate: toString(item.endDate),
    gpa: toString(item.gpa),
    description: renderDescriptionRows(item.description).join("\n"),
    visible: item.visible !== false,
  }));
  resume.experience = (Array.isArray(result?.experience) ? result.experience : []).map((item: any) => ({
    id: toString(item.id) || generateUUID(),
    company: toString(item.company),
    position: toString(item.position),
    date: toString(item.date),
    details: renderDescriptionRows(item.details).join("\n"),
    visible: item.visible !== false,
  }));
  resume.projects = (Array.isArray(result?.projects) ? result.projects : []).map((item: any) => ({
    id: toString(item.id) || generateUUID(),
    name: toString(item.name),
    role: toString(item.role),
    date: toString(item.date),
    description: renderDescriptionRows(item.description).join("\n"),
    visible: item.visible !== false,
  }));
  resume.markdownContent = buildMarkdownContent(result);
  resume.skillContent = renderDescriptionRows(result?.skills).join("\n");
  return resume;
}
