import { API_BASE } from "./apiBase";
import { authHeaders, handleUnauthorized } from "./auth";

export type AdminRange = 7 | 30 | 90;

export interface AdminDashboard {
  range: AdminRange;
  // 全部 daily 指标按该偏移（分钟）换算的本地自然日切分。
  tzOffset: number;
  overview: {
    users: number;
    newUsers: number;
    masterResumes: number;
    derivedResumes: number;
    jobs: number;
    llmCalls: number;
    totalTokens: number;
    creditsConsumed: number;
    // 区间口径由后端给出：PV 可加总，UV 必须在整个窗口内去重。
    totalPv: number;
    uniqueVisitors: number;
  };
  daily: Array<{
    date: string;
    pv: number;
    uv: number;
    newUsers: number;
    matches: number;
    jobs: number;
    llmCalls: number;
  }>;
  growthFunnel: GrowthFunnel;
}

export interface GrowthFunnel {
  landingView: number;
  ctaClick: number;
  registerStart: number;
  registerSuccess: number;
  resumeCreated: number;
  firstMatchSuccess: number;
  sessionStart: number;
}

export function growthConversionRate(current: number, previous: number): number {
  if (previous <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, current) / previous) * 100));
}

export async function fetchAdminDashboard(days: AdminRange): Promise<AdminDashboard> {
  const response = await fetch(`${API_BASE}/api/admin/dashboard?days=${days}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (response.status === 401) handleUnauthorized();
  if (!response.ok) throw new Error("加载系统统计失败");
  return response.json() as Promise<AdminDashboard>;
}
