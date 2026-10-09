export interface QuickStartState {
  hasResume: boolean;
  hasJd: boolean;
  hasResult: boolean;
}

/** 1=准备简历，2=粘贴 JD，3=开始匹配，4=已完成。 */
export function getQuickStartStep(state: QuickStartState): 1 | 2 | 3 | 4 {
  if (state.hasResult) return 4;
  if (!state.hasResume) return 1;
  if (!state.hasJd) return 2;
  return 3;
}
