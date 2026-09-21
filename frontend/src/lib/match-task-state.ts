export type MatchTaskMode = "match" | "pitch" | "both";

export interface MatchTaskState<TResult> {
  activeRequestId: number;
  matchPending: boolean;
  pitchPending: boolean;
  matchError: string | null;
  pitchError: string | null;
  result: TResult | null;
}

export type MatchTaskAction<TResult> =
  | { type: "task-started"; requestId: number; mode: MatchTaskMode }
  | {
      type: "match-succeeded";
      requestId: number;
      result: TResult;
      continueWithPitch: boolean;
    }
  | { type: "match-failed"; requestId: number; error: string }
  | { type: "pitch-succeeded"; requestId: number }
  | { type: "pitch-failed"; requestId: number; error: string };

export function initialMatchTaskState<TResult>(): MatchTaskState<TResult> {
  return {
    activeRequestId: 0,
    matchPending: false,
    pitchPending: false,
    matchError: null,
    pitchError: null,
    result: null,
  };
}

export function isTaskSubmissionLocked<TResult>(
  state: MatchTaskState<TResult>
): boolean {
  return state.matchPending || state.pitchPending;
}

export function isMatchResultVisible<TResult>(
  state: MatchTaskState<TResult>
): boolean {
  return state.result !== null;
}

export function beginMatchTask<TResult>(
  state: MatchTaskState<TResult>,
  requestId: number,
  mode: MatchTaskMode
): MatchTaskState<TResult> {
  if (isTaskSubmissionLocked(state)) return state;

  return {
    activeRequestId: requestId,
    matchPending: mode !== "pitch",
    pitchPending: mode === "pitch",
    matchError: null,
    pitchError: null,
    result: null,
  };
}

export function matchTaskReducer<TResult>(
  state: MatchTaskState<TResult>,
  action: MatchTaskAction<TResult>
): MatchTaskState<TResult> {
  if (action.type === "task-started") {
    return beginMatchTask(state, action.requestId, action.mode);
  }
  if (action.requestId !== state.activeRequestId) return state;

  switch (action.type) {
    case "match-succeeded":
      return {
        ...state,
        matchPending: false,
        pitchPending: action.continueWithPitch,
        matchError: null,
        pitchError: null,
        result: action.result,
      };
    case "match-failed":
      return {
        ...state,
        matchPending: false,
        pitchPending: false,
        matchError: action.error,
      };
    case "pitch-succeeded":
      return {
        ...state,
        pitchPending: false,
        pitchError: null,
      };
    case "pitch-failed":
      return {
        ...state,
        pitchPending: false,
        pitchError: action.error,
      };
  }
}
