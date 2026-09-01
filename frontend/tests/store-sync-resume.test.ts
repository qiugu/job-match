/**
 * 回归测试（2026-08-31 导入简历 404）：
 *
 * 现象：导入 PDF 后跳编辑器 GET /api/master-resumes/{旧uuid} 404，简历呈空白。
 * 根因链：
 *   1) addResume 产生本地临时 uuid；
 *   2) syncResumeToBackend 落库成功后，store 内缓存 key 从临时 uuid 替换为后端 id；
 *   3) 若跳转仍用旧 uuid，编辑器 loader 在 store 中找不到该 id，
 *      转而 GET 后端 -> 404。
 *
 * 本文件锁定 store.syncResumeToBackend 的 id 替换契约：
 *   - 未落库 -> 调 createMasterResumeJson，旧 key 被后端 id 替换，syncedIds 更新；
 *   - 已落库 -> 调 updateMasterResume 且目标 id 必须是真实后端记录 id；
 *   - 创建失败（如 409 标题重复）-> 错误透传，本地缓存 key 不变（保持可编辑）。
 * 调用方（ResumeWorkbench.importResumeFromPdf）必须以返回的 { id } 作为跳转 id。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// store 内部通过 await import("@/lib/jobmatch") 动态加载 API 客户端，
// vi.mock 对动态 import 同样生效；node 环境无需真实网络与登录态。
vi.mock("@/lib/jobmatch", () => ({
  createMasterResumeJson: vi.fn(),
  updateMasterResume: vi.fn(),
}));

// @/config 会引出组件注册表（templates/registry），测试环境无 DOM，mock 掉。
vi.mock("@/config", () => ({
  MARKDOWN_TEMPLATES: [],
}));

import { createMasterResumeJson, updateMasterResume } from "@/lib/jobmatch";
import { useResumeStore } from "@/store/useResumeStore";
import { blankResumeState } from "@/config/initialResumeData";
import type { ResumeData } from "@/types/resume";
import { generateUUID } from "@/utils/uuid";

const mockedCreate = vi.mocked(createMasterResumeJson);
const mockedUpdate = vi.mocked(updateMasterResume);

function seedLocalResume(title = "Imported.pdf"): { localId: string; data: ResumeData } {
  const localId = generateUUID();
  const data = { ...blankResumeState, id: localId, title } as ResumeData;
  useResumeStore.setState((state) => ({
    resumes: { ...state.resumes, [localId]: data },
    activeResumeId: localId,
    activeResume: data,
    syncedIds: new Set<string>(),
  }));
  return { localId, data };
}

beforeEach(() => {
  vi.clearAllMocks();
  useResumeStore.setState({
    resumes: {},
    activeResumeId: null,
    activeResume: null,
    syncedIds: new Set<string>(),
  });
});

describe("syncResumeToBackend（导入落库的 id 替换契约）", () => {
  it("未落库：POST 创建成功后，缓存 key 必须从临时 uuid 替换为后端 id", async () => {
    const { localId, data } = seedLocalResume();
    const backendId = generateUUID();
    mockedCreate.mockResolvedValue({
      id: backendId,
      title: data.title,
      createdAt: "2026-08-31T00:00:00Z",
      updatedAt: "2026-08-31T00:00:00Z",
    });

    const result = await useResumeStore.getState().syncResumeToBackend(localId);

    expect(mockedCreate).toHaveBeenCalledOnce();
    expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ id: localId }));
    expect(mockedUpdate).not.toHaveBeenCalled();

    // 旧 key 必须被移除、后端 id 必须存在且已标记 synced —— 跳转依赖这个 id
    const state = useResumeStore.getState();
    expect(state.resumes[localId]).toBeUndefined();
    expect(state.resumes[backendId]).toBeDefined();
    expect(state.resumes[backendId]!.id).toBe(backendId);
    expect(state.syncedIds.has(backendId)).toBe(true);
    expect(state.activeResumeId).toBe(backendId);

    expect(result).toEqual({ id: backendId, created: true });
  });

  it("已落库：PUT 更新，且目标 id 必须是真实后端记录 id", async () => {
    const backendId = generateUUID();
    // 已落库状态：缓存 key 已是后端 id，syncedIds 已标记
    const data = { ...blankResumeState, id: backendId, title: "Imported.pdf" } as ResumeData;
    useResumeStore.setState({
      resumes: { [backendId]: data },
      activeResumeId: backendId,
      activeResume: data,
      syncedIds: new Set<string>([backendId]),
    });
    mockedUpdate.mockResolvedValue({ id: backendId });

    const result = await useResumeStore.getState().syncResumeToBackend(backendId);

    // 防止 PUT /api/master-resumes/ -> 405：backendId 必须显式传入
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: backendId }),
      backendId
    );
    expect(mockedCreate).not.toHaveBeenCalled();
    // key 保持为后端 id，不发生替换
    expect(useResumeStore.getState().resumes[backendId]).toBeDefined();
    expect(result).toEqual({ id: backendId, created: false });
  });

  it("创建失败（409 标题重复等）：错误透传，本地缓存 key 不变、保持可编辑", async () => {
    const { localId } = seedLocalResume();
    mockedCreate.mockRejectedValue(
      Object.assign(new Error("简历名称「Imported.pdf」已存在"), { status: 409 })
    );

    await expect(
      useResumeStore.getState().syncResumeToBackend(localId)
    ).rejects.toMatchObject({ status: 409 });

    const state = useResumeStore.getState();
    expect(state.resumes[localId]).toBeDefined();
    expect(state.syncedIds.has(localId)).toBe(false);
  });
});
