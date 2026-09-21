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

export function getTemplateCardLabel(index: number, total: number) {
  return `Template ${index + 1} of ${total}`;
}
