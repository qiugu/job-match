import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("dashboard regression guard", () => {
  it("keeps delivery and matching observability under one analytics route", () => {
    const sidebar = source("src/app/app/dashboard/client.tsx");
    const analytics = source("src/app/app/dashboard/analytics/page.tsx");

    expect(sidebar).toContain('url: "/app/dashboard/analytics"');
    expect(analytics).toContain('"delivery"');
    expect(analytics).toContain('"matching"');
    expect(analytics).toContain("<MatchingObservability");
  });

  it("labels the account balance as credits", () => {
    const zh = JSON.parse(source("src/i18n/locales/zh.json"));
    expect(zh.auth.quota).toBe("剩余积分");
    expect(zh.auth.quotaUnlimited).toBe("积分不限");
  });

  it("does not present the primary action as ready without a JD", () => {
    const matchPage = source("src/app/app/dashboard/match/page.tsx");
    expect(matchPage).toContain("disabled={loading || !selected || !jdText.trim()}");
  });
});
