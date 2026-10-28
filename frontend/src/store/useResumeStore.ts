import { create } from "zustand";
// 注意：2026-08-29 起「简历唯一数据源改为后端 master_resumes」。
// 不再使用 persist middleware 把简历写入 localStorage（刷新后从后端重载）；
// 也不再同步简历到本地目录文件（useResumeDirectorySync / resumeFileSync 已停用）。
// 前端 store 仅作为编辑器的内存工作副本。简历 id 恒等于后端记录 id，
// 不再有 masterResumeId 概念——store 内部用 syncedIds 标记哪些 id 已落库。
import {
  BasicInfo,
  Education,
  Experience,
  GlobalSettings,
  Project,
  CustomItem,
  ResumeData,
  MenuSection,
  Certificate,
} from "../types/resume";
import type { MasterResumeSummary } from "@/lib/jobmatch";
import { MARKDOWN_TEMPLATES } from "@/config";
import {
  initialResumeState,
  initialResumeStateEn,
  blankResumeState,
  blankResumeStateEn,
} from "@/config/initialResumeData";
import { generateUUID } from "@/utils/uuid";
import {
  HISTORY_LIMIT,
  type UpdateResumeOptions,
  cloneResume,
  getHistoryKey,
  shouldPushHistoryEntry,
  pushHistory,
  restoreResumeSnapshot,
  clearHistoryGroup,
} from "./resumeHistory";

interface ResumeStore {
  resumes: Record<string, ResumeData>;
  activeResumeId: string | null;
  activeResume: ResumeData | null;
  history: Record<string, ResumeData[]>;
  future: Record<string, ResumeData[]>;
  /** 已落库到后端 master_resumes 的简历 id 集合。store 不污染 ResumeData 类型，
   *  用此集合区分「内存新建（临时 id）」与「已落库（后端 id）」。 */
  syncedIds: Set<string>;
  /**
   * 脏标记基准快照：以「最近一次成功落库（或刚从后端加载）的内容」为该简历的
   * 干净基准，key 为简历 id。顶栏据此判定 isDirty。由所有成功落库的路径
   * （syncResumeToBackend）与后端加载（loadResumesFromBackend）统一写入，
   * 保证「自动保存 / 手动保存 / 换简历」任一路径后脏标记都一致（修复 I2）。
   */
  savedSnapshots: Record<string, string>;

  createResume: (templateId: string | null, isBlank?: boolean) => Promise<string>;
  deleteResume: (resume: ResumeData) => void;
  duplicateResume: (resumeId: string) => string;
  updateResume: (
    resumeId: string,
    data: Partial<ResumeData>,
    options?: UpdateResumeOptions
  ) => void;
  setActiveResume: (resumeId: string) => void;
  updateResumeFromFile: (
    resume: ResumeData,
    sourceModifiedAt?: number
  ) => boolean;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  updateResumeTitle: (title: string) => void;
  updateBasicInfo: (data: Partial<BasicInfo>) => void;
  updateEducation: (data: Education) => void;
  updateEducationBatch: (educations: Education[]) => void;
  deleteEducation: (id: string) => void;
  updateExperience: (data: Experience) => void;
  updateExperienceBatch: (experiences: Experience[]) => void;
  deleteExperience: (id: string) => void;
  updateProjects: (project: Project) => void;
  updateProjectsBatch: (projects: Project[]) => void;
  deleteProject: (id: string) => void;
  setDraggingProjectId: (id: string | null) => void;
  updateSkillContent: (skillContent: string) => void;
  updateSelfEvaluationContent: (content: string) => void;
  reorderSections: (newOrder: ResumeData["menuSections"]) => void;
  toggleSectionVisibility: (sectionId: string) => void;
  setActiveSection: (sectionId: string) => void;
  updateMenuSections: (sections: ResumeData["menuSections"]) => void;
  createCustomSection: (section: MenuSection) => void;
  updateCustomData: (sectionId: string, items: CustomItem[]) => void;
  removeCustomData: (sectionId: string) => void;
  addCustomItem: (sectionId: string) => void;
  updateCustomItem: (
    sectionId: string,
    itemId: string,
    updates: Partial<CustomItem>
  ) => void;
  removeCustomItem: (sectionId: string, itemId: string) => void;
  updateGlobalSettings: (settings: Partial<GlobalSettings>) => void;
  setThemeColor: (color: string) => void;
  setTemplate: (templateId: string) => void;
  addResume: (resume: ResumeData) => string;
  addCertificate: (certificate: Certificate) => void;
  updateCertificate: (id: string, updates: Partial<Certificate>) => void;
  updateCertificatesBatch: (certificates: Certificate[]) => void;
  removeCertificate: (id: string) => void;
  /** 将当前激活简历（含 markdown 内容）上传/更新到后端数据库，回写后端记录 id */
  saveActiveResumeToBackend: () => Promise<{ id: string; created: boolean }>;
  /** 将指定简历同步到后端：未落库 POST 创建并替换 id 为后端 id；已落库 PUT 更新 */
  syncResumeToBackend: (resumeId: string) => Promise<{ id: string; created: boolean }>;
  /** 从后端 master_resumes 拉取全部简历填充内存（刷新后/进入列表页时调用） */
  loadResumesFromBackend: () => Promise<MasterResumeSummary[]>;
}

type PersistedResumeStore = Pick<ResumeStore, "resumes" | "activeResumeId">;

/**
 * 排版设置自动保存的模块级防抖计时器（修复 I1）。
 * 放在 store 外层，使「左侧面板所有排版控件 + 主题色」共用一个落库节流窗口，
 * 拖动滑块时不会每次 onChange 都发请求。
 */
let globalSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

const createDefaultCustomItem = (): CustomItem => ({
  id: generateUUID(),
  title: "未命名模块",
  subtitle: "",
  dateRange: "",
  description: "",
  visible: true,
});

const parseTimestamp = (value?: string): number | null => {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const shouldImportResumeFromFile = (
  fileResume: ResumeData,
  localResume?: ResumeData,
  sourceModifiedAt?: number
) => {
  if (!localResume) {
    return true;
  }

  const fileUpdatedAt = parseTimestamp(fileResume.updatedAt);
  const localUpdatedAt = parseTimestamp(localResume.updatedAt);
  const fileModifiedAt =
    typeof sourceModifiedAt === "number" && Number.isFinite(sourceModifiedAt)
      ? sourceModifiedAt
      : null;

  if (fileUpdatedAt !== null && localUpdatedAt !== null) {
    if (fileUpdatedAt !== localUpdatedAt) {
      return fileUpdatedAt > localUpdatedAt;
    }

    return fileModifiedAt !== null && fileModifiedAt > localUpdatedAt + 1000;
  }

  if (fileUpdatedAt !== null && localUpdatedAt === null) {
    return true;
  }

  if (fileUpdatedAt === null && localUpdatedAt !== null) {
    return fileModifiedAt !== null && fileModifiedAt > localUpdatedAt + 1000;
  }

  return fileModifiedAt !== null;
};

const normalizeImportedResume = (
  resume: ResumeData,
  sourceModifiedAt?: number
) => {
  if (
    typeof sourceModifiedAt !== "number" ||
    !Number.isFinite(sourceModifiedAt)
  ) {
    return resume;
  }

  const fileUpdatedAt = parseTimestamp(resume.updatedAt);
  if (fileUpdatedAt !== null && fileUpdatedAt >= sourceModifiedAt) {
    return resume;
  }

  return {
    ...resume,
    updatedAt: new Date(sourceModifiedAt).toISOString(),
  };
};

// 注意：2026-08-29 起本地目录文件同步（useResumeDirectorySync / resumeFileSync）
// 已停用。简历唯一数据源是后端 master_resumes，前端不再把简历同步到 Downloads/简历
// 等本地目录文件。下方原 syncResumeToFile / debouncedSyncToFile 已删除。

export const useResumeStore = create<ResumeStore>((set, get) => ({
  resumes: {},
  activeResumeId: null,
  activeResume: null,
  history: {},
  future: {},
  syncedIds: new Set<string>(),
  savedSnapshots: {},

      createResume: async (templateId = null, isBlank = false) => {
        const locale =
          typeof document !== "undefined"
            ? document.cookie
                .split("; ")
                .find((row) => row.startsWith("NEXT_LOCALE="))
                ?.split("=")[1] || "zh"
            : "zh";

        let initialResumeData: any;
        if (isBlank) {
          initialResumeData =
            locale === "en" ? blankResumeStateEn : blankResumeState;
        } else {
          initialResumeData =
            locale === "en" ? initialResumeStateEn : initialResumeState;
        }

        const tempId = generateUUID();
        const template = templateId
          ? MARKDOWN_TEMPLATES.find((t) => t.id === templateId)
          : MARKDOWN_TEMPLATES[0];

        const newResume: ResumeData = {
          ...initialResumeData,
          id: tempId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          templateId: template?.id,
          title: `${locale === "en" ? "New Resume" : "新建简历"} ${tempId.slice(
            0,
            6
          )}`,
        };

        set((state) => ({
          resumes: {
            ...state.resumes,
            [tempId]: newResume,
          },
          activeResumeId: tempId,
          activeResume: newResume,
          history: {
            ...state.history,
            [tempId]: [],
          },
          future: {
            ...state.future,
            [tempId]: [],
          },
        }));

        // 新建即落库：直接 POST 后端拿到真实 id，使「我的简历」与「优化简历」
        // 下拉同源一致，不存在「内存草稿」概念。
        try {
          const { saveResumeToBackend } = await import("@/lib/jobmatch");
          const result = await saveResumeToBackend(newResume);
          const backendId = result.id;
          set((state) => {
            const nextSynced = new Set(state.syncedIds);
            nextSynced.add(backendId);
            const updated: ResumeData = {
              ...newResume,
              id: backendId,
              updatedAt: new Date().toISOString(),
            };
            const nextResumes = { ...state.resumes };
            if (backendId !== tempId) {
              delete nextResumes[tempId];
            }
            nextResumes[backendId] = updated;
            const sameActive =
              state.activeResumeId === tempId ? backendId : state.activeResumeId;
            return {
              resumes: nextResumes,
              activeResumeId: sameActive,
              activeResume:
                sameActive === backendId ? updated : state.activeResume,
              syncedIds: nextSynced,
            };
          });
          return backendId;
        } catch (err) {
          // 落库失败：保留内存草稿，便于用户重试，不影响继续编辑
          console.error("新建简历落库失败:", err);
          return tempId;
        }
      },

      updateResume: (resumeId, data, options) => {
        set((state) => {
          const resume = state.resumes[resumeId];
          if (!resume) return state;

          const historyKey = getHistoryKey(data, options);
          const shouldPushHistory =
            !!historyKey && shouldPushHistoryEntry(resumeId, historyKey);
          const shouldClearFuture = !!historyKey;
          const updatedResume = {
            ...resume,
            ...data,
            updatedAt: new Date().toISOString(),
          };

          return {
            resumes: {
              ...state.resumes,
              [resumeId]: updatedResume,
            },
            activeResume:
              state.activeResumeId === resumeId
                ? updatedResume
                : state.activeResume,
            history: shouldPushHistory
              ? pushHistory(state.history, resumeId, resume)
              : state.history,
            future: shouldClearFuture
              ? {
                  ...state.future,
                  [resumeId]: [],
                }
              : state.future,
          };
        });
      },

      // 从文件更新，直接更新resumes
      updateResumeFromFile: (resume, sourceModifiedAt) => {
        const localResume = get().resumes[resume.id];
        if (!shouldImportResumeFromFile(resume, localResume, sourceModifiedAt)) {
          return false;
        }

        const importedResume = normalizeImportedResume(resume, sourceModifiedAt);
        clearHistoryGroup(importedResume.id);

        set((state) => ({
          resumes: {
            ...state.resumes,
            [importedResume.id]: importedResume,
          },
          activeResume:
            state.activeResumeId === importedResume.id
              ? importedResume
              : state.activeResume,
          history: {
            ...state.history,
            [importedResume.id]: [],
          },
          future: {
            ...state.future,
            [importedResume.id]: [],
          },
        }));

        return true;
      },

      undo: () => {
        const { activeResumeId } = get();
        if (!activeResumeId) return;

        set((state) => {
          const currentResume = state.resumes[activeResumeId];
          const resumeHistory = state.history[activeResumeId] ?? [];
          const previousResume = resumeHistory[resumeHistory.length - 1];
          if (!currentResume || !previousResume) return state;

          const restoredResume = restoreResumeSnapshot(
            previousResume,
            currentResume
          );
          clearHistoryGroup(activeResumeId);

          return {
            resumes: {
              ...state.resumes,
              [activeResumeId]: restoredResume,
            },
            activeResume: restoredResume,
            history: {
              ...state.history,
              [activeResumeId]: resumeHistory.slice(0, -1),
            },
            future: {
              ...state.future,
              [activeResumeId]: [
                cloneResume(currentResume),
                ...(state.future[activeResumeId] ?? []),
              ].slice(0, HISTORY_LIMIT),
            },
          };
        });
      },

      redo: () => {
        const { activeResumeId } = get();
        if (!activeResumeId) return;

        set((state) => {
          const currentResume = state.resumes[activeResumeId];
          const resumeFuture = state.future[activeResumeId] ?? [];
          const nextResume = resumeFuture[0];
          if (!currentResume || !nextResume) return state;

          const restoredResume = restoreResumeSnapshot(
            nextResume,
            currentResume
          );
          clearHistoryGroup(activeResumeId);

          return {
            resumes: {
              ...state.resumes,
              [activeResumeId]: restoredResume,
            },
            activeResume: restoredResume,
            history: pushHistory(state.history, activeResumeId, currentResume),
            future: {
              ...state.future,
              [activeResumeId]: resumeFuture.slice(1),
            },
          };
        });
      },

      canUndo: () => {
        const { activeResumeId, history } = get();
        return !!activeResumeId && (history[activeResumeId]?.length ?? 0) > 0;
      },

      canRedo: () => {
        const { activeResumeId, future } = get();
        return !!activeResumeId && (future[activeResumeId]?.length ?? 0) > 0;
      },

      updateResumeTitle: (title) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(activeResumeId, { title });
        }
      },

      deleteResume: (resume) => {
        const resumeId = resume.id;
        clearHistoryGroup(resumeId);
        set((state) => {
          const { [resumeId]: _, activeResume, ...rest } = state.resumes;
          const { [resumeId]: __, ...historyRest } = state.history;
          const { [resumeId]: ___, ...futureRest } = state.future;
          const nextSynced = new Set(state.syncedIds);
          nextSynced.delete(resumeId);
          return {
            resumes: rest,
            activeResumeId: null,
            activeResume: null,
            history: historyRest,
            future: futureRest,
            syncedIds: nextSynced,
          };
        });

        // 始终尝试删除后端记录（master_resumes）：
        // 已落库记录正常删除；未落库纯内存草稿后端会返回 404，视为幂等成功静默忽略，
        // 不会报错刷屏，也绝不会漏发请求。此前用 syncedIds 守卫会误判跳过真实删除，
        // 导致「前端删除成功但后端没删、刷新又重现」的 bug。
        (async () => {
          try {
            const { deleteMasterResume } = await import("@/lib/jobmatch");
            await deleteMasterResume(resumeId);
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 404) {
              // 记录已在后端不存在，视为已删除，静默忽略
              return;
            }
            console.error("Error deleting resume from backend:", error);
          }
        })();
      },

      duplicateResume: (resumeId) => {
        const newId = generateUUID();
        const originalResume = get().resumes[resumeId];
        if (!originalResume) {
          return "";
        }

        // 获取当前语言环境
        const locale =
          typeof document !== "undefined"
            ? document.cookie
                .split("; ")
                .find((row) => row.startsWith("NEXT_LOCALE="))
                ?.split("=")[1] || "zh"
            : "zh";

        const duplicatedResume = {
          ...structuredClone(originalResume),
          id: newId,
          title: `${originalResume.title} (${
            locale === "en" ? "Copy" : "复制"
          })`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          resumes: {
            ...state.resumes,
            [newId]: duplicatedResume,
          },
          activeResumeId: newId,
          activeResume: duplicatedResume,
          history: {
            ...state.history,
            [newId]: [],
          },
          future: {
            ...state.future,
            [newId]: [],
          },
        }));

        return newId;
      },

      setActiveResume: (resumeId) => {
        const { resumes, activeResume, activeResumeId } = get();
        const nextResume = resumes[resumeId] ?? null;

        if (activeResumeId === resumeId && activeResume === nextResume) {
          return;
        }

        set((state) => {
          // 切换到一个已落库、但尚未记录脏基准的简历时，以当前内容作干净起点
          // （否则首帧会拿另一份简历的旧快照比较 → 误报未保存，修复 I2 的时序窗口）。
          const hasBaseline = state.savedSnapshots[resumeId] !== undefined;
          const shouldSeed = nextResume && state.syncedIds.has(resumeId) && !hasBaseline;
          return {
            activeResume: nextResume,
            activeResumeId: resumeId,
            savedSnapshots: shouldSeed
              ? { ...state.savedSnapshots, [resumeId]: JSON.stringify(nextResume) }
              : state.savedSnapshots,
          };
        });
      },

      updateBasicInfo: (data) => {
        const { activeResumeId, activeResume } = get();
        if (activeResumeId && activeResume) {
          get().updateResume(activeResumeId, {
            basic: {
              ...activeResume.basic,
              ...data,
            },
          });
        }
      },

      updateEducation: (education) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const currentResume = resumes[activeResumeId];
        const newEducation = currentResume.education.some(
          (e) => e.id === education.id
        )
          ? currentResume.education.map((e) =>
              e.id === education.id ? education : e
            )
          : [...currentResume.education, education];

        get().updateResume(activeResumeId, { education: newEducation });
      },

      updateEducationBatch: (educations) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(activeResumeId, { education: educations });
        }
      },

      deleteEducation: (id) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const resume = get().resumes[activeResumeId];
          const updatedEducation = resume.education.filter((e) => e.id !== id);
          get().updateResume(activeResumeId, { education: updatedEducation });
        }
      },

      updateExperience: (experience) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const currentResume = resumes[activeResumeId];
        const newExperience = currentResume.experience.find(
          (e) => e.id === experience.id
        )
          ? currentResume.experience.map((e) =>
              e.id === experience.id ? experience : e
            )
          : [...currentResume.experience, experience];

        get().updateResume(activeResumeId, { experience: newExperience });
      },

      updateExperienceBatch: (experiences: Experience[]) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const updateData = { experience: experiences };
          get().updateResume(activeResumeId, updateData);
        }
      },
      deleteExperience: (id) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const currentResume = resumes[activeResumeId];
        const updatedExperience = currentResume.experience.filter(
          (e) => e.id !== id
        );

        get().updateResume(activeResumeId, { experience: updatedExperience });
      },

      updateProjects: (project) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;
        const currentResume = resumes[activeResumeId];
        const newProjects = currentResume.projects.some(
          (p) => p.id === project.id
        )
          ? currentResume.projects.map((p) =>
              p.id === project.id ? project : p
            )
          : [...currentResume.projects, project];

        get().updateResume(activeResumeId, { projects: newProjects });
      },

      updateProjectsBatch: (projects: Project[]) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const updateData = { projects };
          get().updateResume(activeResumeId, updateData);
        }
      },

      deleteProject: (id) => {
        const { activeResumeId } = get();
        if (!activeResumeId) return;
        const currentResume = get().resumes[activeResumeId];
        const updatedProjects = currentResume.projects.filter(
          (p) => p.id !== id
        );
        get().updateResume(activeResumeId, { projects: updatedProjects });
      },

      setDraggingProjectId: (id: string | null) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(
            activeResumeId,
            { draggingProjectId: id },
            { recordHistory: false }
          );
        }
      },

      updateSkillContent: (skillContent) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(activeResumeId, { skillContent });
        }
      },

      updateSelfEvaluationContent: (selfEvaluationContent) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(activeResumeId, { selfEvaluationContent });
        }
      },

      reorderSections: (newOrder) => {
        const { activeResumeId, resumes } = get();
        if (activeResumeId) {
          const currentResume = resumes[activeResumeId];
          const basicInfoSection = currentResume.menuSections.find(
            (section) => section.id === "basic"
          );
          const reorderedSections = [
            basicInfoSection,
            ...newOrder.filter((section) => section.id !== "basic"),
          ].map((section, index) => ({
            ...section,
            order: index,
          }));
          get().updateResume(activeResumeId, {
            menuSections: reorderedSections as MenuSection[],
          });
        }
      },

      toggleSectionVisibility: (sectionId) => {
        const { activeResumeId, resumes } = get();
        if (activeResumeId) {
          const currentResume = resumes[activeResumeId];
          const updatedSections = currentResume.menuSections.map((section) =>
            section.id === sectionId
              ? { ...section, enabled: !section.enabled }
              : section
          );
          get().updateResume(activeResumeId, { menuSections: updatedSections });
        }
      },

      setActiveSection: (sectionId) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(
            activeResumeId,
            { activeSection: sectionId },
            { recordHistory: false }
          );
        }
      },

      updateMenuSections: (sections) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(activeResumeId, { menuSections: sections });
        }
      },

      createCustomSection: (section) => {
        const { activeResumeId } = get();
        if (!activeResumeId) return;

        const currentResume = get().resumes[activeResumeId];
        get().updateResume(activeResumeId, {
          menuSections: [...currentResume.menuSections, section],
          customData: {
            ...currentResume.customData,
            [section.id]: [createDefaultCustomItem()],
          },
          activeSection: section.id,
        });
      },

      updateCustomData: (sectionId, items) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const currentResume = get().resumes[activeResumeId];
          const updatedCustomData = {
            ...currentResume.customData,
            [sectionId]: items,
          };
          get().updateResume(activeResumeId, { customData: updatedCustomData });
        }
      },

      removeCustomData: (sectionId) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const currentResume = get().resumes[activeResumeId];
          const { [sectionId]: _, ...rest } = currentResume.customData;
          get().updateResume(activeResumeId, { customData: rest });
        }
      },

      addCustomItem: (sectionId) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const currentResume = get().resumes[activeResumeId];
          const updatedCustomData = {
            ...currentResume.customData,
            [sectionId]: [
              ...(currentResume.customData[sectionId] || []),
              createDefaultCustomItem(),
            ],
          };
          get().updateResume(activeResumeId, { customData: updatedCustomData });
        }
      },

      updateCustomItem: (sectionId, itemId, updates) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const currentResume = get().resumes[activeResumeId];
          const updatedCustomData = {
            ...currentResume.customData,
            [sectionId]: currentResume.customData[sectionId].map((item) =>
              item.id === itemId ? { ...item, ...updates } : item
            ),
          };
          get().updateResume(activeResumeId, { customData: updatedCustomData });
        }
      },

      removeCustomItem: (sectionId, itemId) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          const currentResume = get().resumes[activeResumeId];
          const updatedCustomData = {
            ...currentResume.customData,
            [sectionId]: currentResume.customData[sectionId].filter(
              (item) => item.id !== itemId
            ),
          };
          get().updateResume(activeResumeId, { customData: updatedCustomData });
        }
      },

      addCertificate: (certificate) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const currentResume = resumes[activeResumeId];
        const newCertificates = currentResume.certificates.some(
          (c) => c.id === certificate.id
        )
          ? currentResume.certificates.map((c) =>
              c.id === certificate.id ? certificate : c
            )
          : [...currentResume.certificates, certificate];

        get().updateResume(activeResumeId, { certificates: newCertificates });
      },

      updateCertificate: (id, updates) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const currentResume = resumes[activeResumeId];
        const newCertificates = currentResume.certificates.map((c) =>
          c.id === id ? { ...c, ...updates } : c
        );

        get().updateResume(activeResumeId, { certificates: newCertificates });
      },

      updateCertificatesBatch: (certificates) => {
        const { activeResumeId } = get();
        if (activeResumeId) {
          get().updateResume(activeResumeId, { certificates });
        }
      },

      removeCertificate: (id) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const currentResume = resumes[activeResumeId];
        const updatedCertificates = currentResume.certificates.filter(
          (c) => c.id !== id
        );

        get().updateResume(activeResumeId, { certificates: updatedCertificates });
      },

      updateGlobalSettings: (settings: Partial<GlobalSettings>) => {
        const { activeResumeId, updateResume, activeResume } = get();
        if (activeResumeId) {
          updateResume(activeResumeId, {
            globalSettings: {
              ...activeResume?.globalSettings,
              ...settings,
            },
          });
        }
        // 自动保存（防抖）：让左栏排版设置真正落库，兑现面板「auto-save」承诺（修复 I1）。
        // 与主题色共用同一落库路径，drag 过程中 600ms 内多次调用只触发一次保存。
        if (activeResumeId) {
          if (globalSettingsSaveTimer) clearTimeout(globalSettingsSaveTimer);
          globalSettingsSaveTimer = setTimeout(() => {
            get()
              .saveActiveResumeToBackend()
              .catch((err) => console.error("排版设置自动保存失败:", err));
          }, 600);
        }
      },

      setThemeColor: (color) => {
        const { activeResumeId, updateResume } = get();
        if (activeResumeId) {
          updateResume(activeResumeId, {
            globalSettings: {
              ...get().activeResume?.globalSettings,
              themeColor: color,
            },
          });
        }
        // 主题色同样走自动保存（防抖），与排版设置同源（修复 I1）。
        if (activeResumeId) {
          if (globalSettingsSaveTimer) clearTimeout(globalSettingsSaveTimer);
          globalSettingsSaveTimer = setTimeout(() => {
            get()
              .saveActiveResumeToBackend()
              .catch((err) => console.error("主题色自动保存失败:", err));
          }, 600);
        }
      },

      setTemplate: (templateId) => {
        const { activeResumeId, resumes } = get();
        if (!activeResumeId) return;

        const template = MARKDOWN_TEMPLATES.find((t) => t.id === templateId);
        if (!template) return;

        const currentSettings = resumes[activeResumeId].globalSettings;
        // 切换模板时沿用当前主题色：主题色属于「简历自身」的设置，
        // 不应随模板而变化，否则列表页缩略图会被模板默认色统一。
        const { themeColor: _, ...templateSettingsWithoutTheme } = template.globalSettings;

        get().updateResume(activeResumeId, {
          templateId,
          globalSettings: {
            ...currentSettings,
            ...templateSettingsWithoutTheme,
            themeColor: currentSettings.themeColor,
          },
        });
      },
      addResume: (resume: ResumeData) => {
        set((state) => ({
          resumes: {
            ...state.resumes,
            [resume.id]: resume,
          },
          activeResumeId: resume.id,
          activeResume: resume,
          history: {
            ...state.history,
            [resume.id]: [],
          },
          future: {
            ...state.future,
            [resume.id]: [],
          },
          // 导入的简历尚未落库（id 为前端临时 uuid）
          syncedIds: (() => {
            const next = new Set(state.syncedIds);
            next.delete(resume.id);
            return next;
          })(),
        }));
        return resume.id;
      },

      saveActiveResumeToBackend: async () => {
        const { activeResumeId } = get();
        if (!activeResumeId) throw new Error("没有可保存的简历");
        return get().syncResumeToBackend(activeResumeId);
      },

      /** 将指定简历同步到后端：未落库的 POST 创建并替换 id 为后端 id；
       *  已落库的 PUT 更新。返回后端记录 id 与是否新建。 */
      syncResumeToBackend: async (resumeId: string) => {
        const resume = get().resumes[resumeId];
        if (!resume) throw new Error("简历不存在");

        const { createMasterResumeJson, updateMasterResume } = await import(
          "@/lib/jobmatch"
        );
        const synced = get().syncedIds.has(resumeId);

        // 已落库 -> 用后端 id 直接 PUT 更新；未落库 -> POST 新建拿后端 id。
        // 传给 updateMasterResume 的 resumeId 是真实后端记录 id（来自 URL / store），
        // 避免 resume_json 内嵌的 id 为空（历史脏数据）导致 PUT /api/master-resumes/ -> 405。
        const result = synced
          ? await updateMasterResume(resume, resumeId)
          : await createMasterResumeJson(resume);

        const backendId = result.id;
        const created = !synced && backendId !== resumeId;

        set((state) => {
          const nextSynced = new Set(state.syncedIds);
          nextSynced.add(backendId);

          // 落库后 id 与缓存 key 统一为后端 id
          const updated: ResumeData = {
            ...resume,
            id: backendId,
            updatedAt: new Date().toISOString(),
          };

          const nextResumes = { ...state.resumes };
          if (backendId !== resumeId) {
            delete nextResumes[resumeId];
          }
          nextResumes[backendId] = updated;

          // 落库成功 → 刷新脏基准。所有保存路径（手动 / 自动）都经此处，
          // 因此脏标记不会像旧实现那样只被手动保存刷新（修复 I2）。
          const nextSnapshots = { ...state.savedSnapshots };
          if (backendId !== resumeId) {
            delete nextSnapshots[resumeId];
          }
          nextSnapshots[backendId] = JSON.stringify(updated);

          const sameActive =
            state.activeResumeId === resumeId ? backendId : state.activeResumeId;

          return {
            resumes: nextResumes,
            activeResumeId: sameActive,
            activeResume:
              sameActive === backendId ? updated : state.activeResume,
            syncedIds: nextSynced,
            savedSnapshots: nextSnapshots,
          };
        });

        return { id: backendId, created };
      },

      /** 从后端 master_resumes 拉取全部简历填充内存（刷新后/进入列表页时调用）。
       *  每条都拉取结构化详情，使「我的简历」页卡片预览与之前一致。
       *  内存中未落库（临时 id）的简历保留不动，不被覆盖。 */
      loadResumesFromBackend: async () => {
        const { listMasterResumes, getMasterResume } = await import(
          "@/lib/jobmatch"
        );
        const summaries = await listMasterResumes();
        const details = await Promise.all(
          summaries.map((s) =>
            getMasterResume(s.id).catch(() => null)
          )
        );

        set((state) => {
          const nextResumes = { ...state.resumes };
          const nextSynced = new Set(state.syncedIds);
          const nextSnapshots = { ...state.savedSnapshots };
          for (const detail of details) {
            if (!detail) continue;
            nextSynced.add(detail.id);
            // 后端记录优先；若内存已有同名未落库副本则保留（不会冲突，id 不同）
            // 强制把后端真实 id 对齐到 resumeJson.id，避免历史脏数据里残留的
            // 前端临时 uuid 被当作记录 id，导致删除/更新时 404。
            const aligned = { ...detail.resumeJson, id: detail.id };
            nextResumes[detail.id] = aligned;
            // 从后端加载即为干净起点（未被本地修改前不应显示「未保存」，修复 I2）。
            nextSnapshots[detail.id] = JSON.stringify(aligned);
          }
          return {
            resumes: nextResumes,
            syncedIds: nextSynced,
            savedSnapshots: nextSnapshots,
          };
        });

        return summaries;
      },
    })
);
