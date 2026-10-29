import type { JobStatus } from "@/lib/jobmatch";

export type ApplicationStageTone = "waiting" | "ready" | "applied" | "closed";

export function getApplicationStageMeta(status: JobStatus): {
  index: number;
  label: string;
  tone: ApplicationStageTone;
} {
  const stages: Record<JobStatus, { index: number; label: string; tone: ApplicationStageTone }> = {
    greeting_sent: { index: 1, label: "jobStatusGreetingSent", tone: "waiting" },
    resume_ready: { index: 2, label: "jobStatusResumeReady", tone: "ready" },
    applied: { index: 3, label: "jobStatusApplied", tone: "applied" },
    closed: { index: 0, label: "jobStatusClosed", tone: "closed" },
  };

  return stages[status];
}

/**
 * 模板卡片的无障碍位置描述（如 "Template 2 of 4"）。
 * 使用方：`app/dashboard/templates/page.tsx`（模板选择面板组件，当前未挂路由，
 * 入口收敛在「创建简历」弹窗内；保留该组件供后续复用）。
 */
export function getTemplateCardLabel(index: number, total: number) {
  return `Template ${index + 1} of ${total}`;
}
