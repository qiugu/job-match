import { create } from "zustand";
import { toast } from "sonner";
import Mark from "mark.js";
import { cn } from "@/lib/utils";
import { authHeaders, handleUnauthorized } from "@/lib/auth";

export interface GrammarError {
  context: string;
  text: string;
  suggestion: string;
  reason: string;
  type: "spelling" | "grammar";
}

interface GrammarStore {
  isChecking: boolean;
  hasChecked: boolean;
  errors: GrammarError[];
  selectedErrorIndex: number | null;
  highlightKey: number;
  setErrors: (errors: GrammarError[]) => void;
  setIsChecking: (isChecking: boolean) => void;
  setSelectedErrorIndex: (index: number | null) => void;
  incrementHighlightKey: () => void;
  checkGrammar: (text: string) => Promise<void>;
  clearErrors: () => void;
  selectError: (index: number) => void;
  dismissError: (index: number) => void;
  /**
   * 预览 DOM 重建后重新套用高亮（修复 I3）。
   * 预览每次 markdown 变化都会 dangerouslySetInnerHTML 重建，旧的 DOM 注入
   * mark 会被整体抹掉；由预览提交后的 `resume-preview-updated` 事件驱动重标，
   * 使「敲一个字 → 波浪线全消失、但抽屉里错误还在」的割裂不再出现。
   */
  remarkErrors: () => void;
}

/**
 * 预览的「分页显示副本」根节点（修复 I3）。
 *
 * 多页简历里每一页都是一个 `.md-page-sheet`，其内的 `.resume-markdown-preview`
 * 才是可见正文；隐藏测量副本虽然也带同一个类，但不在 `.md-page-sheet` 内，
 * 因此这里能天然排除它。旧实现只取 `#resume-preview`（仅第一页），导致第 2 页
 * 及之后的错误永远无法高亮/定位。
 */
const getPreviewRoots = (): HTMLElement[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      ".md-page-sheet .resume-markdown-preview"
    )
  );

const markSingleError = (
  marker: Mark,
  error: GrammarError,
  options?: { selected?: boolean; activeIndex?: number }
) => {
  const keyword = (error.text || "").trim();
  if (!keyword) return;

  let hasMarked = false;
  marker.mark(keyword, {
    separateWordSearch: false,
    acrossElements: true,
    className: cn(
      "grammar-error",
      error.type,
      options?.selected &&
        options?.activeIndex !== undefined &&
        `active-${options.activeIndex}`
    ),
    filter: () => {
      if (hasMarked) return false;
      hasMarked = true;
      return true;
    },
  });
};

/**
 * 在所有分页显示副本上重新套用高亮（单一入口）。
 * 先清除旧 mark，再按错误逐个标记；每页每个错误只标首个命中，避免误高亮。
 */
const applyMarks = (errors: GrammarError[], selectedIndex: number | null) => {
  const roots = getPreviewRoots();
  roots.forEach((root) => new Mark(root).unmark());
  if (errors.length === 0) return;
  errors.forEach((error, i) => {
    roots.forEach((root) => {
      markSingleError(new Mark(root), error, {
        selected: selectedIndex === i,
        activeIndex: selectedIndex ?? undefined,
      });
    });
  });
};

const getPreviewScrollContainer = (element: HTMLElement): HTMLElement | null => {
  const containers = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-preview-scroll-container="true"]'
    )
  );

  for (const container of containers) {
    if (container.contains(element)) {
      return container;
    }
  }

  let current: HTMLElement | null = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScrollY = /(auto|scroll)/.test(style.overflowY);
    if (canScrollY && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
};

export const useGrammarStore = create<GrammarStore>((set, get) => ({
  isChecking: false,
  hasChecked: false,
  errors: [],
  selectedErrorIndex: null,
  highlightKey: 0,

  setErrors: (errors) => set({ errors }),
  setIsChecking: (isChecking) => set({ isChecking }),
  setSelectedErrorIndex: (selectedErrorIndex) =>
    set({ selectedErrorIndex }),
  incrementHighlightKey: () =>
    set((state) => ({ highlightKey: state.highlightKey + 1 })),

  checkGrammar: async (text: string) => {
    set({ isChecking: true, hasChecked: false, errors: [] });

    try {
      const response = await fetch("/api/ai/grammar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          content: text,
        }),
      });

      if (response.status === 401) {
        handleUnauthorized();
      }

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        toast.error(data.error.message);
        throw new Error(data.error.message);
      }

      if (data.error?.code === "AuthenticationError") {
        toast.error("ApiKey 或 模型Id 不正确");
        throw new Error(data.error.message);
      }

      const aiResponse = data.choices[0]?.message?.content;

      try {
        const grammarErrors = JSON.parse(aiResponse);
        if (grammarErrors.errors.length === 0) {
          set({ errors: [], hasChecked: true });
          toast.success("无语法错误");
          return;
        }
        set({ errors: grammarErrors.errors, hasChecked: true });

        // 跨所有分页标记（I3），不再只标第一页
        applyMarks(grammarErrors.errors, null);
      } catch (parseError) {
        toast.error(`解析AI响应失败: ${parseError}`);
        set({ errors: [], hasChecked: false });
      }
    } catch (error) {
      set({ errors: [], hasChecked: false });
    } finally {
      set({ isChecking: false });
    }
  },

  clearErrors: () => {
    applyMarks([], null);
    set({ errors: [], selectedErrorIndex: null });
  },

  selectError: (index: number) => {
    const { errors } = get();
    const error = errors[index];
    if (!error) return;

    set({ selectedErrorIndex: index });

    // 重新标记所有分页，并给选中项加 active-<index>，然后跨页查找它的 mark。
    applyMarks(errors, index);
    const selectedMark = document.querySelector<HTMLElement>(
      `mark.active-${index}`
    );
    if (!selectedMark) return;

    const scrollContainer = getPreviewScrollContainer(selectedMark);
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const markRect = selectedMark.getBoundingClientRect();
    const currentTop = scrollContainer.scrollTop;
    const nextTop =
      currentTop +
      (markRect.top - containerRect.top) -
      scrollContainer.clientHeight / 2 +
      markRect.height / 2;
    const maxTop = Math.max(
      0,
      scrollContainer.scrollHeight - scrollContainer.clientHeight
    );

    scrollContainer.scrollTo({
      top: Math.max(0, Math.min(nextTop, maxTop)),
      behavior: "smooth",
    });
  },

  dismissError: (index: number) => {
    const { errors } = get();
    const newErrors = errors.filter((_, i) => i !== index);
    set({ errors: newErrors, selectedErrorIndex: null });
    // 剩余错误重新标记（跨所有分页）
    applyMarks(newErrors, null);
  },

  remarkErrors: () => {
    const { errors, selectedErrorIndex } = get();
    if (errors.length === 0) return;
    applyMarks(errors, selectedErrorIndex);
  },
}));
