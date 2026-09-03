// 登录鉴权：令牌存储与账号 API。
//
// 后端只允许登录用户调用简历 / 匹配 / AI 接口——AI 能力由后端统一持有 api_key，
// 匿名可调用等同于把额度公开，因此所有请求都必须携带 Bearer 令牌。
import { API_BASE } from "./apiBase";

export const TOKEN_STORAGE_KEY = "jdmatch.auth.token";

// 令牌存 sessionStorage：会话级、关闭标签页即清除，比 localStorage 的持久化窗口更短，
// 降低 XSS 盗用后的可用窗口。后端同时签发 HttpOnly Cookie 作为双通道。
function _store(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
  role: "admin" | "user";
  /** 剩余可发起的「简历匹配 JD」次数，-1 表示无限制（管理员） */
  matchQuota: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthResponse {
  token: string;
  tokenType: string;
  expiresIn: number;
  user: AuthUser;
}

/**
 * 后端 4xx/5xx 的统一错误类型。
 *
 * 除状态码外还带 retryAfter（来自 429 的 Retry-After 响应头，单位秒）——限流
 * 提示需要告诉用户「还要等多久」，而不是让他反复点击碰运气。
 */
export class ApiError extends Error {
  readonly status: number;
  /** 还需等待的秒数；非 429 或服务端未给出时为 null */
  readonly retryAfter: number | null;

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/** 令牌统一存 sessionStorage（见顶部注释），取用统一走 getToken，清理时不会漏。 */
export function getToken(): string | null {
  return _store()?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

export function setToken(token: string): void {
  _store()?.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  _store()?.removeItem(TOKEN_STORAGE_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 登录态失效（401）：清理本地令牌并跳登录页，登录后自动回到原页面。 */
export function handleUnauthorized(): void {
  if (typeof window === "undefined") return;
  clearToken();
  if (window.location.pathname.startsWith("/login")) return;
  const redirect = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    // 优先用后端 detail。中间层（网关 / 代理 / CDN）返回的限流响应常是 HTML，
    // 解析不出 JSON 时会丢掉全部信息，因此 429 必须有中文兜底文案。
    let detail = "";
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* 非 JSON 响应，走下方兜底 */
    }
    if (!detail) {
      detail =
        res.status === 429
          ? "操作过于频繁，请稍后再试"
          : `请求失败 (${res.status})`;
    }
    throw new ApiError(detail, res.status, parseRetryAfter(res.headers.get("Retry-After")));
  }
  return res.json() as Promise<T>;
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/** 注册必须带注册码：注册码决定该账号获得多少次匹配额度 */
export function register(
  username: string,
  password: string,
  code: string
): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password, code }),
  });
}

export function fetchMe(): Promise<AuthUser> {
  return request<AuthUser>("/api/auth/me");
}

export async function logout(): Promise<void> {
  // 服务端递增 token_version 使令牌失效；即便请求失败也要保证本地已登出
  try {
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    clearToken();
  }
}

export function changePassword(
  oldPassword: string,
  newPassword: string
): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ oldPassword, newPassword }),
  });
}

// ---------- 自助领取注册码（官网 FAQ 入口，匿名可用） ----------

export interface RegistrationCodeStatus {
  /** 每日发放上限 */
  dailyLimit: number;
  /** 今日剩余可领数量 */
  remaining: number;
  /** 注册码授予的匹配次数 */
  grantMatches: number;
  /** 有效天数 */
  validityDays: number;
  /** 下次重置时间（ISO8601 含时区，前端转本地时区展示） */
  nextResetAt: string;
}

export interface RegistrationCodeIssue {
  code: string;
  grantMatches: number;
  /** 过期时间（ISO8601 含时区） */
  expiresAt: string;
  /** 领取后的今日剩余名额 */
  remaining: number;
  nextResetAt: string;
}

/** 弹框打开时查询：今日剩余名额与下次重置时间（顶部状态条） */
export function fetchRegistrationCodeStatus(): Promise<RegistrationCodeStatus> {
  return request<RegistrationCodeStatus>("/api/auth/registration-code/status");
}

/** 领取一枚注册码；429 时 detail 为后端给出的重置提示 */
export function issueRegistrationCode(): Promise<RegistrationCodeIssue> {
  return request<RegistrationCodeIssue>("/api/auth/registration-code", {
    method: "POST",
  });
}
