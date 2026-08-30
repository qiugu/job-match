// 登录态：令牌 + 当前用户信息。
//
// status=unknown 表示尚未用本地令牌向后端确认过身份，此时路由守卫会先
// 调用 initialize 再决定是否放行（避免刷新页面时把已登录用户踢到登录页）。
import { create } from "zustand";

import {
  AuthUser,
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
  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 匹配成功后用后端返回的剩余次数刷新本地显示 */
  applyQuota: (remaining: number) => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  status: "unknown",
  user: null,
  submitting: false,
  error: null,

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
      set({ status: "authenticated", user: res.user, submitting: false });
    } catch (error) {
      set({
        submitting: false,
        error: error instanceof Error ? error.message : "登录失败",
      });
      throw error;
    }
  },

  register: async (username, password, code) => {
    set({ submitting: true, error: null });
    try {
      const res = await registerApi(username, password, code);
      setToken(res.token);
      set({ status: "authenticated", user: res.user, submitting: false });
    } catch (error) {
      set({
        submitting: false,
        error: error instanceof Error ? error.message : "注册失败",
      });
      throw error;
    }
  },

  logout: async () => {
    await logoutApi();
    set({ status: "anonymous", user: null, error: null });
  },

  applyQuota: (remaining) =>
    set((state) =>
      state.user ? { user: { ...state.user, matchQuota: remaining } } : state
    ),

  clearError: () => set({ error: null }),
}));
