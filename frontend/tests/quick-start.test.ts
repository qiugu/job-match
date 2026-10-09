import { describe, expect, it } from "vitest";

import { getQuickStartStep } from "@/lib/quick-start";

describe("getQuickStartStep", () => {
  it("starts with resume upload", () => {
    expect(getQuickStartStep({ hasResume: false, hasJd: false, hasResult: false })).toBe(1);
  });

  it("moves to the JD after a resume is ready", () => {
    expect(getQuickStartStep({ hasResume: true, hasJd: false, hasResult: false })).toBe(2);
  });

  it("moves to matching when both inputs are ready", () => {
    expect(getQuickStartStep({ hasResume: true, hasJd: true, hasResult: false })).toBe(3);
  });

  it("marks the runway complete after a result is created", () => {
    expect(getQuickStartStep({ hasResume: true, hasJd: true, hasResult: true })).toBe(4);
  });
});
