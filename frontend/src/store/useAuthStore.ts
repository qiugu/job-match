// 登录态：令牌 + 当前用户信息。
//
// status=unknown 表示尚未用本地令牌向后端确认过身份，此时路由守卫会先
// 调用 initialize 再决定是否放行（避免刷新页面时把已登录用户踢到登录页）。
import { create } from "zustand";

import {
  ApiError,
  AuthUser,
  changePassword as changePasswordApi,
  clearToken,
  fetchMe,
  getToken,
  login as loginApi,
  logout as logoutApi,
  register as registerApi,
  setToken,
} from "@/lib/auth";

export type AuthStatus = "unknown" | "authenticated" | "anonymous";

interface AuthStore {
  status: AuthStatus;
  user: AuthUser | null;
  submitting: boolean;
  error: string | null;
  /**
   * 被限流（429）时的冷却截止时刻，Date.now() 毫秒；null 表示未限流。
   * 由页面据此禁用提交按钮并倒计时，避免用户在明知会被拒时反复点击。
   */
  cooldownUntil: number | null;
  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * 修改密码。后端改密后会递增 token_version 使旧令牌立即失效，并在响应里回发
   * 新令牌，因此这里必须落地新令牌——否则改密成功后的每个业务请求都会 401。
   */
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  /** 消耗型动作成功后用后端返回的剩余积分刷新本地显示 */
  applyCredits: (remaining: number) => void;
  clearError: () => void;
  clearCooldown: () => void;
}

/** 429 时把 Retry-After 换算成冷却截止时刻；其它错误不进入冷却。 */
function cooldownFrom(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  if (!error.retryAfter) return null;
  return Date.now() + error.retryAfter * 1000;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status: "unknown",
  user: null,
  submitting: false,
  error: null,
  cooldownUntil: null,

  initialize: async () => {
    if (!getToken()) {
      set({ status: "anonymous", user: null });
      return;
    }
    try {
      const user = await fetchMe();
      set({ status: "authenticated", user });
    } catch {
      // 令牌过期/被服务端失效：清掉本地残留，按未登录处理
      clearToken();
      set({ status: "anonymous", user: null });
    }
  },

  login: async (username, password) => {
    set({ submitting: true, error: null });
    try {
      const res = await loginApi(username, password);
      setToken(res.token);
      set({
        status: "authenticated",
        user: res.user,
        submitting: false,
        error: null,
        cooldownUntil: null,
      });
    } catch (error) {
      set({
        submitting: false,
        error: error instanceof Error ? error.message : "登录失败",
        cooldownUntil: cooldownFrom(error),
      });
      throw error;
    }
  },

  register: async (username, password) => {
    set({ submitting: true, error: null });
    try {
      const res = await registerApi(username, password);
      setToken(res.token);
      set({
        status: "authenticated",
        user: res.user,
        submitting: false,
        error: null,
        cooldownUntil: null,
      });
    } catch (error) {
      set({
        submitting: false,
        error: error instanceof Error ? error.message : "注册失败",
        cooldownUntil: cooldownFrom(error),
      });
      throw error;
    }
  },

  logout: async () => {
    await logoutApi();
    set({ status: "anonymous", user: null, error: null, cooldownUntil: null });
  },

  changePassword: async (oldPassword, newPassword) => {
    set({ submitting: true, error: null });
    try {
      const res = await changePasswordApi(oldPassword, newPassword);
      // 旧令牌已被服务端作废，换成响应里回发的新令牌，当前会话保持登录
      setToken(res.token);
      set({
        status: "authenticated",
        user: res.user,
        submitting: false,
        error: null,
        cooldownUntil: null,
      });
    } catch (error) {
      set({
        submitting: false,
        error: error instanceof Error ? error.message : "修改密码失败",
        cooldownUntil: cooldownFrom(error),
      });
      throw error;
    }
  },

  applyCredits: (remaining) =>
    set((state) =>
      state.user ? { user: { ...state.user, credits: remaining } } : state
    ),

  clearError: () => set({ error: null }),

  clearCooldown: () => set({ cooldownUntil: null, error: null }),
}));
