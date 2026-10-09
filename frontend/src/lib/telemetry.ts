import { API_BASE } from "./apiBase";
import { getToken } from "./auth";

export type GrowthEventName =
  | "landing_view"
  | "cta_click"
  | "register_start"
  | "register_success"
  | "resume_created"
  | "first_match_success"
  | "session_start";

export interface Attribution {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  referrer: string;
}

interface GrowthEventPayloadInput {
  eventId: string;
  eventName: GrowthEventName;
  visitorId: string;
  path: string;
  attribution: Attribution;
}

const VISITOR_KEY = "jdmatch.analytics.visitor-id";
const ATTRIBUTION_KEY = "jdmatch.growth.first-touch";
const SESSION_DATE_KEY = "jdmatch.growth.session-date";
const trackedPaths = new Set<string>();

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getVisitorId(): string {
  if (typeof window === "undefined") return "server";
  const storage = safeLocalStorage();
  const existing = storage?.getItem(VISITOR_KEY);
  if (existing) return existing;
  const value = crypto.randomUUID();
  storage?.setItem(VISITOR_KEY, value);
  return value;
}

export function parseAttribution(url: string, referrer = ""): Attribution {
  try {
    const parsed = new URL(url);
    return {
      utmSource: parsed.searchParams.get("utm_source") ?? "",
      utmMedium: parsed.searchParams.get("utm_medium") ?? "",
      utmCampaign: parsed.searchParams.get("utm_campaign") ?? "",
      referrer,
    };
  } catch {
    return { utmSource: "", utmMedium: "", utmCampaign: "", referrer };
  }
}

export function mergeFirstTouchAttribution(
  existing: Attribution,
  incoming: Attribution
): Attribution {
  return {
    utmSource: existing.utmSource || incoming.utmSource,
    utmMedium: existing.utmMedium || incoming.utmMedium,
    utmCampaign: existing.utmCampaign || incoming.utmCampaign,
    referrer: existing.referrer || incoming.referrer,
  };
}

function readAttribution(): Attribution {
  const storage = safeLocalStorage();
  const empty: Attribution = {
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
    referrer: "",
  };
  let existing = empty;
  try {
    existing = JSON.parse(storage?.getItem(ATTRIBUTION_KEY) ?? "null") ?? empty;
  } catch {
    existing = empty;
  }
  const incoming =
    typeof window === "undefined"
      ? empty
      : parseAttribution(window.location.href, document.referrer);
  const merged = mergeFirstTouchAttribution(existing, incoming);
  storage?.setItem(ATTRIBUTION_KEY, JSON.stringify(merged));
  return merged;
}

export function buildGrowthEventPayload(input: GrowthEventPayloadInput) {
  return {
    eventId: input.eventId.slice(0, 64),
    eventName: input.eventName,
    visitorId: input.visitorId.slice(0, 128),
    path: input.path.slice(0, 255),
    referrer: input.attribution.referrer.slice(0, 512),
    utmSource: input.attribution.utmSource.slice(0, 128),
    utmMedium: input.attribution.utmMedium.slice(0, 128),
    utmCampaign: input.attribution.utmCampaign.slice(0, 128),
  };
}

export function growthEventHeaders(token: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function shouldTrackDailySession(lastDate: string | null, today: string): boolean {
  return lastDate !== today;
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

export async function trackGrowthEvent(
  eventName: GrowthEventName,
  options: { path?: string } = {}
): Promise<void> {
  if (typeof window === "undefined") return;
  const payload = buildGrowthEventPayload({
    eventId: crypto.randomUUID(),
    eventName,
    visitorId: getVisitorId(),
    path: options.path ?? window.location.pathname,
    attribution: readAttribution(),
  });
  try {
    await fetch(`${API_BASE}/api/growth-events`, {
      method: "POST",
      headers: growthEventHeaders(getToken()),
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // 增长遥测失败不能阻断注册、上传或匹配主流程。
  }
}

export async function trackDailySession(path: string): Promise<void> {
  if (typeof window === "undefined") return;
  const storage = safeLocalStorage();
  const today = new Date().toLocaleDateString("en-CA");
  if (!shouldTrackDailySession(storage?.getItem(SESSION_DATE_KEY) ?? null, today)) {
    return;
  }
  storage?.setItem(SESSION_DATE_KEY, today);
  await trackGrowthEvent("session_start", { path });
}

export function __resetTelemetryForTests(): void {
  trackedPaths.clear();
}
