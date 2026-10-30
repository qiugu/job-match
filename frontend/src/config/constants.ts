import { BasicFieldType } from "@/types/resume";

export const DEFAULT_FIELD_ORDER: BasicFieldType[] = [
  { id: "1", key: "name", label: "姓名", type: "text", visible: true },

  { id: "2", key: "title", label: "职位", type: "text", visible: true },
  {
    id: "3",
    key: "employementStatus",
    label: "状态",
    type: "text",
    visible: true
  },
  { id: "4", key: "birthDate", label: "生日", type: "date", visible: true },
  { id: "5", key: "email", label: "邮箱", type: "text", visible: true },
  { id: "6", key: "phone", label: "电话", type: "text", visible: true },
  { id: "7", key: "location", label: "所在地", type: "text", visible: true }
];

/**
 * 本项目自有 GitHub 仓库（slug）。站内所有指向 GitHub 的链接与星标 API
 * 一律由它派生，避免各处硬编码、各自漂移。
 *
 * 历史问题（2026-10-30 修复）：移动端菜单的「Star on GitHub」按钮硬编码了
 * 上游 fork 仓库「JOYCEQL 的 magic-resume」，把访客引到了别人的仓库；
 * 桌面端顶栏没有该按钮，因此只有移动端暴露出来。
 */
export const GITHUB_REPO_SLUG = "qiugu/job-match";

/** 仓库主页链接（对外跳转） */
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_SLUG}`;

/** 仓库 REST API（取 stargazers_count，无需鉴权的公开接口） */
export const GITHUB_API_REPO_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}`;
