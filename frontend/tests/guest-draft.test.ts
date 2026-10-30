/**
 * 游客草稿本地持久化的契约测试（PLAN_guest_access P2）。
 *
 * 锁定三条红线：
 * 1. 写入成功 = true，读取回环内容一致；写失败（无存储/超容量）= false，
 *    绝不静默丢数据；
 * 2. 损坏的 JSON / 缺失字段一律按「无草稿」处理，不抛异常；
 * 3. 无 window（node/SSR）时全部安全降级。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GUEST_DRAFT_STORAGE_KEY,
  clearGuestDraft,
  hasGuestDraft,
  readGuestDraft,
  writeGuestDraft,
} from "@/lib/guestDraft";
import { blankResumeState } from "@/config/initialResumeData";
import type { ResumeData } from "@/types/resume";

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    _map: map,
  };
}

const sampleResume = () =>
  ({ ...blankResumeState, id: "draft-1", title: "Guest.pdf" }) as unknown as ResumeData;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("guestDraft（游客草稿本地持久化）", () => {
  it("写入成功后读取回环一致；clearGuestDraft 清除", () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });

    expect(writeGuestDraft(sampleResume())).toBe(true);
    expect(hasGuestDraft()).toBe(true);

    const record = readGuestDraft();
    expect(record?.version).toBe(1);
    expect(record?.resume.id).toBe("draft-1");
    expect(record?.resume.title).toBe("Guest.pdf");
    expect(typeof record?.savedAt).toBe("string");

    clearGuestDraft();
    expect(hasGuestDraft()).toBe(false);
    expect(storage._map.has(GUEST_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("无 window（node/SSR）时写入失败、读取为 null，不抛异常", () => {
    expect(writeGuestDraft(sampleResume())).toBe(false);
    expect(readGuestDraft()).toBeNull();
    expect(hasGuestDraft()).toBe(false);
    expect(() => clearGuestDraft()).not.toThrow();
  });

  it("超容量（>2MB）写入被拒绝，返回 false", () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });

    const huge = {
      ...sampleResume(),
      title: "x".repeat(1_200_000),
    } as unknown as ResumeData;
    expect(writeGuestDraft(huge)).toBe(false);
    expect(hasGuestDraft()).toBe(false);
  });

  it("损坏的 JSON / 缺字段按无草稿处理，不抛异常", () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });

    storage.setItem(GUEST_DRAFT_STORAGE_KEY, "{not-json");
    expect(readGuestDraft()).toBeNull();

    storage.setItem(GUEST_DRAFT_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    expect(readGuestDraft()).toBeNull();

    storage.setItem(
      GUEST_DRAFT_STORAGE_KEY,
      JSON.stringify({ version: 99, savedAt: "x", resume: { id: "y" } })
    );
    expect(readGuestDraft()).toBeNull();
  });
});
