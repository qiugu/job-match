/**
 * 游客（未登录）模式的状态管理。
 *
 * 两个独立 store：
 * - useGuestMode：/edit 游客路由挂载期间 active=true，携带当前草稿 id。
 *   useResumeStore 的保存路径据此把「落库后端」切换为「写本地草稿」，
 *   红线：游客态不允许发出任何后端业务请求（登录/注册除外）。
 * - useGuestGate：游客点击「登录墙内功能」（PDF 导出 / AI 校对 / AI 润色 /
 *   翻译）时的登录引导弹窗状态。触发方只 request(feature)，
 *   由 /edit 路由挂载的 GateHost 渲染弹窗。
 *
 * 为什么用 store 而不是模块级布尔：游客/登录两条路径可能在同一次 SPA 会话
 * 中先后出现（/edit → 登录 → /app），store 的 set/get 保证任何时刻读到的是
 * 当前路由的最新状态，也便于 React 组件以 hook 订阅。
 */

import { create } from "zustand";

/** 登录墙内功能清单：决定引导弹窗的文案与登录后的回跳意图。 */
export type GuestFeature = "pdf" | "grammar" | "polish" | "translate";

interface GuestModeState {
  active: boolean;
  /** 游客当前编辑的本地草稿 id（内存中的临时 uuid） */
  resumeId: string | null;
  enter: (resumeId: string) => void;
  exit: () => void;
}

export const useGuestMode = create<GuestModeState>((set) => ({
  active: false,
  resumeId: null,
  enter: (resumeId) => set({ active: true, resumeId }),
  exit: () => set({ active: false, resumeId: null }),
}));

/** 供非 React 模块（如 useResumeStore 的保存路径）同步读取。 */
export const isGuestModeActive = (): boolean => useGuestMode.getState().active;

interface GuestGateState {
  open: boolean;
  feature: GuestFeature | null;
  request: (feature: GuestFeature) => void;
  close: () => void;
}

export const useGuestGate = create<GuestGateState>((set) => ({
  open: false,
  feature: null,
  request: (feature) => set({ open: true, feature }),
  close: () => set({ open: false, feature: null }),
}));
