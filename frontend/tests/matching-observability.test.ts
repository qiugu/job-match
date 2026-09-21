import { describe, expect, it } from "vitest";

import {
  formatMatchingDuration,
  matchingDailyMax,
  matchingQualityTotal,
  matchingSuccessRate,
} from "@/components/analytics/matching-scale";

describe("matching observability scale helpers", () => {
  it("uses a safe zero denominator for success rate", () => {
    expect(matchingSuccessRate(0, 0)).toBe(0);
    expect(matchingSuccessRate(3, 4)).toBe(0.75);
  });

  it("sums the four quality buckets", () => {
    expect(
      matchingQualityTotal({
        matched: 4,
        weak: 2,
        missing: 3,
        unsupported: 1,
        total_requirements: 0,
      })
    ).toBe(10);
  });

  it("keeps daily bar scales usable for empty data", () => {
    expect(matchingDailyMax([])).toBe(1);
    expect(matchingDailyMax([0, 3, 2])).toBe(3);
  });

  it("formats latency in a compact user-facing unit", () => {
    expect(formatMatchingDuration(null)).toBe("—");
    expect(formatMatchingDuration(850)).toBe("850ms");
    expect(formatMatchingDuration(1850)).toBe("1.9s");
  });
});
