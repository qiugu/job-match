import { API_BASE } from "./apiBase";

const VISITOR_KEY = "jdmatch.analytics.visitor-id";
const trackedPaths = new Set<string>();

function getVisitorId(): string {
  if (typeof window === "undefined") return "server";
  const existing = window.localStorage.getItem(VISITOR_KEY);
  if (existing) return existing;
  const value = crypto.randomUUID();
  window.localStorage.setItem(VISITOR_KEY, value);
  return value;
}

export async function trackPageView(path: string): Promise<void> {
  if (typeof window === "undefined" || !path || trackedPaths.has(path)) return;
  trackedPaths.add(path);
  try {
    await fetch(`${API_BASE}/api/site-visits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.slice(0, 255), visitorId: getVisitorId() }),
      keepalive: true,
    });
  } catch {
    // 遥测失败不能影响主业务页面。
  }
}

export function __resetTelemetryForTests(): void {
  trackedPaths.clear();
}
