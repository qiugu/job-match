/**
 * 游客态 store 分支的契约测试（PLAN_guest_access P2）。
 *
 * 核心红线：游客态下 useResumeStore 的任何持久化路径都不得发出后端请求
 * （@/lib/jobmatch 全程零调用）：
 * - createResume：跳过落库，返回内存临时 id；
 * - syncResumeToBackend：写 localStorage 草稿 + 维护 syncedIds/savedSnapshots
 *   （脏标记口径 I2 与云朵路径一致），id 不发生替换；
 * - deleteResume / loadResumesFromBackend：不触后端。
 * 另锁定 removeLocalResume 的纯内存清理语义（不清 localStorage）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobmatch", () => ({
  createMasterResumeJson: vi.fn(),
  updateMasterResume: vi.fn(),
  deleteMasterResume: vi.fn(),
  listMasterResumes: vi.fn(),
  getMasterResume: vi.fn(),
}));

vi.mock("@/config", () => ({
  MARKDOWN_TEMPLATES: [],
}));

import {
  createMasterResumeJson,
  deleteMasterResume,
  listMasterResumes,
} from "@/lib/jobmatch";
import { useResumeStore } from "@/store/useResumeStore";
import { useGuestMode } from "@/store/useGuestMode";
import { blankResumeState } from "@/config/initialResumeData";
import type { ResumeData } from "@/types/resume";
import { generateUUID } from "@/utils/uuid";

const mockedCreate = vi.mocked(createMasterResumeJson);
const mockedDelete = vi.mocked(deleteMasterResume);
const mockedList = vi.mocked(listMasterResumes);

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

const GUEST_KEY = "jdmatch.guest.draft";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  useGuestMode.getState().exit();
  useResumeStore.setState({
    resumes: {},
    activeResumeId: null,
    activeResume: null,
    history: {},
    future: {},
    syncedIds: new Set<string>(),
    savedSnapshots: {},
  });
});

describe("游客态 store 分支（零后端请求红线）", () => {
  it("createResume：不落库，返回内存临时 id", async () => {
    useGuestMode.getState().enter("stub");

    const id = await useResumeStore.getState().createResume(null, true);

    expect(id).toBeTruthy();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(useResumeStore.getState().resumes[id]).toBeDefined();
    // 新建即视为未保存：syncedIds 不含临时 id，保存按钮保持可用
    expect(useResumeStore.getState().syncedIds.has(id)).toBe(false);
  });

  it("syncResumeToBackend：写本地草稿并维护脏基准，不触后端、id 不替换", async () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useGuestMode.getState().enter("stub");

    const localId = generateUUID();
    const data = {
      ...blankResumeState,
      id: localId,
      title: "Guest.pdf",
    } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
    }));

    const result = await useResumeStore
      .getState()
      .syncResumeToBackend(localId);

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ id: localId, created: false });

    // 草稿已写入 localStorage，且内容与 store 一致
    const raw = storage._map.get(GUEST_KEY);
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw!);
    expect(record.version).toBe(1);
    expect(record.resume.id).toBe(localId);

    // 脏标记口径与云朵路径一致（I2）：已 synced + 有干净基准
    const state = useResumeStore.getState();
    expect(state.syncedIds.has(localId)).toBe(true);
    expect(state.savedSnapshots[localId]).toBe(JSON.stringify(state.resumes[localId]));
  });

  it("deleteResume：仅清理内存，不请求后端", () => {
    useGuestMode.getState().enter("stub");

    const localId = generateUUID();
    const data = { ...blankResumeState, id: localId } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
      syncedIds: new Set<string>([localId]),
    }));

    useResumeStore.getState().deleteResume(data);

    expect(useResumeStore.getState().resumes[localId]).toBeUndefined();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("loadResumesFromBackend：游客态防御性返回空列表", async () => {
    useGuestMode.getState().enter("stub");

    const summaries = await useResumeStore.getState().loadResumesFromBackend();
    expect(summaries).toEqual([]);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("removeLocalResume：纯内存清理，localStorage 草稿保留", async () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useGuestMode.getState().enter("stub");

    const localId = generateUUID();
    const data = { ...blankResumeState, id: localId } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
      syncedIds: new Set<string>([localId]),
      savedSnapshots: { [localId]: JSON.stringify(data) },
      history: { [localId]: [data] },
    }));
    storage._map.set(GUEST_KEY, JSON.stringify({ version: 1, resume: data }));

    useResumeStore.getState().removeLocalResume(localId);

    const state = useResumeStore.getState();
    expect(state.resumes[localId]).toBeUndefined();
    expect(state.syncedIds.has(localId)).toBe(false);
    expect(state.savedSnapshots[localId]).toBeUndefined();
    expect(state.history[localId]).toBeUndefined();
    // localStorage 草稿不被清除：登录后的导入弹窗要靠它承接
    expect(storage._map.get(GUEST_KEY)).toBeTruthy();
  });
});

describe("游客防抖自动落盘与脏标记（PLAN §4.1/§4.2 丢稿缺口修复）", () => {
  it("updateResume：游客态 600ms 防抖后自动写 localStorage 草稿", async () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useGuestMode.getState().enter("stub");

    const localId = generateUUID();
    const data = {
      ...blankResumeState,
      id: localId,
      title: "before",
    } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
    }));

    vi.useFakeTimers();
    try {
      useResumeStore.getState().updateResume(localId, { title: "after" });

      // 防抖窗口内尚未落盘
      expect(storage._map.get(GUEST_KEY)).toBeFalsy();

      await vi.advanceTimersByTimeAsync(600);

      // 窗口结束自动落盘，内容为最新编辑
      const raw = storage._map.get(GUEST_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).resume.title).toBe("after");
    } finally {
      vi.useRealTimers();
    }
  });

  it("updateResume：云端模式不触发自动保存（保持手动保存语义）", async () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    // 不 enter：云端模式
    useGuestMode.getState().exit();

    const localId = generateUUID();
    const data = {
      ...blankResumeState,
      id: localId,
    } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
    }));

    vi.useFakeTimers();
    try {
      useResumeStore.getState().updateResume(localId, { title: "cloud-edit" });
      await vi.advanceTimersByTimeAsync(2000);

      // 无 localStorage 写入、无后端请求（jobmatch mock 全程零调用）
      expect(storage._map.get(GUEST_KEY)).toBeFalsy();
      expect(mockedCreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hasUnsavedChanges：内存 ≠ 保存基准即脏，落盘后回到干净（I2 口径）", async () => {
    const storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useGuestMode.getState().enter("stub");

    const localId = generateUUID();
    const data = {
      ...blankResumeState,
      id: localId,
    } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
      // 刚保存过：有干净基准
      syncedIds: new Set<string>([localId]),
      savedSnapshots: { [localId]: JSON.stringify(data) },
    }));

    // 干净
    expect(useResumeStore.getState().hasUnsavedChanges()).toBe(false);

    // 编辑后变脏（含防抖窗口内）
    useResumeStore.getState().updateResume(localId, { title: "dirty" });
    expect(useResumeStore.getState().hasUnsavedChanges()).toBe(true);

    // 落盘后回到干净
    await useResumeStore.getState().syncResumeToBackend(localId);
    expect(useResumeStore.getState().hasUnsavedChanges()).toBe(false);
  });

  it("hasUnsavedChanges：无活跃简历或从未保存过时的边界", () => {
    // 无活跃简历 → 不脏（不提示）
    expect(useResumeStore.getState().hasUnsavedChanges()).toBe(false);

    // 有内存简历但从未保存（无 snapshot）→ 脏
    const localId = generateUUID();
    const data = { ...blankResumeState, id: localId } as unknown as ResumeData;
    useResumeStore.setState((state) => ({
      resumes: { ...state.resumes, [localId]: data },
      activeResumeId: localId,
      activeResume: data,
    }));
    expect(useResumeStore.getState().hasUnsavedChanges()).toBe(true);
  });
});
