/**
 * 游客（未登录）简历草稿的本地持久化。
 *
 * 设计约定（docs/PLAN_guest_access.md §4.2）：
 * - 游客态唯一数据源是 localStorage（key 前缀 jdmatch.guest.），单一活跃草稿；
 * - 登录用户的云端简历（master_resumes）与本草稿永不混存：/app 登录墙内
 *   不读取本模块，只有 /edit 游客路由与登录后的导入弹窗会使用它；
 * - 容量超限（>2MB）时写入失败返回 false，由调用方提示用户改用登录保存，
 *   绝不静默丢弃数据。
 */

import type { ResumeData } from "@/types/resume";

export const GUEST_DRAFT_STORAGE_KEY = "jdmatch.guest.draft";

/** 与后端 PDF 导出接口的 HTML 上限同量级的保守阈值。 */
export const GUEST_DRAFT_MAX_BYTES = 2_000_000;

export interface GuestDraftRecord {
  version: 1;
  savedAt: string;
  resume: ResumeData;
}

/**
 * 存储介质获取器：node 测试环境没有 localStorage，统一从这里判空返回，
 * 调用方据此得到「无存储」的明确结果而不是抛异常。
 */
function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Safari 隐私模式等场景访问 localStorage 可能直接抛错：按无存储处理
    return null;
  }
}

/** 读取游客草稿；损坏/缺失/超版本一律返回 null（调用方按无草稿处理）。 */
export function readGuestDraft(): GuestDraftRecord | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(GUEST_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GuestDraftRecord;
    if (parsed?.version !== 1 || !parsed.resume?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasGuestDraft(): boolean {
  return readGuestDraft() !== null;
}

/**
 * 写入游客草稿。返回 false 表示写入失败（无存储或超容量），
 * 调用方必须把失败提示给用户（禁止静默丢数据）。
 */
export function writeGuestDraft(resume: ResumeData): boolean {
  const storage = getStorage();
  if (!storage) return false;

  const record: GuestDraftRecord = {
    version: 1,
    savedAt: new Date().toISOString(),
    resume,
  };
  const raw = JSON.stringify(record);
  // 按 UTF-16 码元近似估算体积（2 字节/字符），超过阈值直接拒绝
  if (raw.length * 2 > GUEST_DRAFT_MAX_BYTES) return false;

  try {
    storage.setItem(GUEST_DRAFT_STORAGE_KEY, raw);
    return true;
  } catch {
    // QuotaExceededError 等：同样按失败处理，由调用方提示
    return false;
  }
}

/** 清除游客草稿。仅在登录后成功导入云端时调用（用户拒绝导入则保留）。 */
export function clearGuestDraft(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(GUEST_DRAFT_STORAGE_KEY);
  } catch {
    // 忽略清除失败：残留草稿不影响登录态功能
  }
}
