import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetTelemetryForTests, trackPageView } from "@/lib/telemetry";

function setupFetch(
  impl: () => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 204 }))
) {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  vi.stubGlobal("crypto", { randomUUID: () => "visitor-id" });
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl);
}

describe("trackPageView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetTelemetryForTests();
  });

  it("keeps one anonymous visitor id and skips only consecutive duplicate paths", async () => {
    const fetchMock = setupFetch();

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

  it("counts a return visit to the same path as another page view", async () => {
    // A→B→A 是三次真实浏览：旧实现按整个会话去重只上报两次，PV 被低估。
    const fetchMock = setupFetch();

    await trackPageView("/app/dashboard");
    await trackPageView("/login");
    await trackPageView("/app/dashboard");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).path))
      .toEqual(["/app/dashboard", "/login", "/app/dashboard"]);
  });

  it("retries the same path after a network failure", async () => {
    const fetchMock = setupFetch(() => Promise.reject(new Error("offline")));

    await trackPageView("/app/dashboard");
    await trackPageView("/app/dashboard");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
