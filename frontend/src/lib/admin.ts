import { API_BASE } from "./apiBase";
import { authHeaders, handleUnauthorized } from "./auth";

export type AdminRange = 7 | 30 | 90;

export interface AdminDashboard {
  range: AdminRange;
  overview: {
    users: number;
    newUsers: number;
    masterResumes: number;
    derivedResumes: number;
    jobs: number;
    llmCalls: number;
    totalTokens: number;
    creditsConsumed: number;
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
}

export async function fetchAdminDashboard(days: AdminRange): Promise<AdminDashboard> {
  const response = await fetch(`${API_BASE}/api/admin/dashboard?days=${days}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (response.status === 401) handleUnauthorized();
  if (!response.ok) throw new Error("加载系统统计失败");
  return response.json() as Promise<AdminDashboard>;
}
