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
    let detail = `请求失败 (${res.status})`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore */
    }
    const error = new Error(detail) as Error & { status?: number };
    error.status = res.status;
    throw error;
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
