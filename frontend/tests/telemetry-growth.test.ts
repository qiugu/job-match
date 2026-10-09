import { describe, expect, it } from "vitest";

import {
  buildGrowthEventPayload,
  growthEventHeaders,
  mergeFirstTouchAttribution,
  parseAttribution,
  shouldTrackDailySession,
} from "@/lib/telemetry";

describe("growth telemetry", () => {
  it("parses UTM values and the external referrer", () => {
    expect(
      parseAttribution(
        "https://jdmatch.site/zh?utm_source=xhs&utm_medium=social&utm_campaign=autumn",
        "https://www.xiaohongshu.com/explore/1"
      )
    ).toEqual({
      utmSource: "xhs",
      utmMedium: "social",
      utmCampaign: "autumn",
      referrer: "https://www.xiaohongshu.com/explore/1",
    });
  });

  it("keeps the first non-empty attribution values", () => {
    expect(
      mergeFirstTouchAttribution(
        { utmSource: "zhihu", utmMedium: "social", utmCampaign: "", referrer: "" },
        { utmSource: "direct", utmMedium: "", utmCampaign: "launch", referrer: "https://ref.example" }
      )
    ).toEqual({
      utmSource: "zhihu",
      utmMedium: "social",
      utmCampaign: "launch",
      referrer: "https://ref.example",
    });
  });

  it("truncates payload fields to the backend contract", () => {
    const payload = buildGrowthEventPayload({
      eventId: "event-12345678",
      eventName: "cta_click",
      visitorId: "visitor-12345678",
      path: `/${"p".repeat(300)}`,
      attribution: {
        utmSource: "s".repeat(160),
        utmMedium: "social",
        utmCampaign: "campaign",
        referrer: "r".repeat(600),
      },
    });

    expect(payload.path).toHaveLength(255);
    expect(payload.utmSource).toHaveLength(128);
    expect(payload.referrer).toHaveLength(512);
  });

  it("adds a bearer token only when one is available", () => {
    expect(growthEventHeaders("token-1")).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
    });
    expect(growthEventHeaders(null)).toEqual({ "Content-Type": "application/json" });
  });

  it("records a daily session only once per local date", () => {
    expect(shouldTrackDailySession(null, "2026-10-09")).toBe(true);
    expect(shouldTrackDailySession("2026-10-08", "2026-10-09")).toBe(true);
    expect(shouldTrackDailySession("2026-10-09", "2026-10-09")).toBe(false);
  });
});
