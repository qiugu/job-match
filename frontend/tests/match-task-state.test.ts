import { describe, expect, it } from "vitest";

import {
  beginMatchTask,
  initialMatchTaskState,
  isMatchResultVisible,
  isTaskSubmissionLocked,
  matchTaskReducer,
} from "@/lib/match-task-state";

type Result = { id: string };

describe("match task state", () => {
  it("shows a completed match while the follow-up pitch is still pending", () => {
    const started = beginMatchTask(initialMatchTaskState<Result>(), 1, "both");
    const matched = matchTaskReducer(started, {
      type: "match-succeeded",
      requestId: 1,
      result: { id: "derived-1" },
      continueWithPitch: true,
    });

    expect(matched.matchPending).toBe(false);
    expect(matched.pitchPending).toBe(true);
    expect(isMatchResultVisible(matched)).toBe(true);
  });

  it("keeps the completed match when pitch generation fails", () => {
    const started = beginMatchTask(initialMatchTaskState<Result>(), 1, "both");
    const matched = matchTaskReducer(started, {
      type: "match-succeeded",
      requestId: 1,
      result: { id: "derived-1" },
      continueWithPitch: true,
    });
    const failed = matchTaskReducer(matched, {
      type: "pitch-failed",
      requestId: 1,
      error: "pitch failed",
    });

    expect(failed.result).toEqual({ id: "derived-1" });
    expect(failed.pitchPending).toBe(false);
    expect(failed.pitchError).toBe("pitch failed");
    expect(isMatchResultVisible(failed)).toBe(true);
  });

  it("ignores an old task response after a newer task starts", () => {
    const first = beginMatchTask(initialMatchTaskState<Result>(), 1, "match");
    const firstDone = matchTaskReducer(first, {
      type: "match-succeeded",
      requestId: 1,
      result: { id: "derived-1" },
      continueWithPitch: false,
    });
    const second = beginMatchTask(firstDone, 2, "match");
    const stale = matchTaskReducer(second, {
      type: "match-succeeded",
      requestId: 1,
      result: { id: "stale-derived" },
      continueWithPitch: false,
    });

    expect(stale).toBe(second);
    expect(stale.result).toBeNull();
    expect(stale.activeRequestId).toBe(2);
  });

  it("keeps submission locked after match completion while pitch is pending", () => {
    const started = beginMatchTask(initialMatchTaskState<Result>(), 1, "both");
    const matched = matchTaskReducer(started, {
      type: "match-succeeded",
      requestId: 1,
      result: { id: "derived-1" },
      continueWithPitch: true,
    });

    expect(isTaskSubmissionLocked(matched)).toBe(true);
    expect(beginMatchTask(matched, 2, "both")).toBe(matched);

    const completed = matchTaskReducer(matched, {
      type: "pitch-succeeded",
      requestId: 1,
    });
    expect(isTaskSubmissionLocked(completed)).toBe(false);
  });
});
