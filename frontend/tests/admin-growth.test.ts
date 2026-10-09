import { describe, expect, it } from "vitest";

import { growthConversionRate } from "@/lib/admin";

describe("growthConversionRate", () => {
  it("returns a rounded percentage for a populated stage", () => {
    expect(growthConversionRate(3, 7)).toBe(43);
  });

  it("returns zero when the previous stage is empty", () => {
    expect(growthConversionRate(0, 0)).toBe(0);
  });

  it("caps malformed data at one hundred percent", () => {
    expect(growthConversionRate(12, 10)).toBe(100);
  });
});
