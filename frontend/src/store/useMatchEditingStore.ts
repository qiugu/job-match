import { create } from "zustand";

interface MatchEditingState {
  /** 当前在编辑器中二次编辑的衍生简历 id（来自匹配专区“在编辑器打开”）。
   *  普通 JSON 导入的简历为 null，此时编辑器不显示“保存匹配结果”。 */
  activeDerivedResumeId: string | null;
  setActiveDerivedResume: (id: string | null) => void;
}

export const useMatchEditingStore = create<MatchEditingState>((set) => ({
  activeDerivedResumeId: null,
  setActiveDerivedResume: (id) => set({ activeDerivedResumeId: id }),
}));
