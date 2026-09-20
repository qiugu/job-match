import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetTelemetryForTests, trackPageView } from "@/lib/telemetry";

describe("trackPageView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetTelemetryForTests();
  });

  it("keeps one anonymous visitor id and sends each path once per session", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "visitor-id" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 })
    );

    await trackPageView("/app/dashboard");
    await trackPageView("/app/dashboard");
    await trackPageView("/app/dashboard/analytics");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(firstBody.visitorId).toBeTruthy();
    expect(secondBody.visitorId).toBe(firstBody.visitorId);
    expect(firstBody.path).toBe("/app/dashboard");
    expect(secondBody.path).toBe("/app/dashboard/analytics");
  });
});
