import { describe, expect, it } from "vitest";

import {
  costNodeTotal,
  dailyLabelStep,
  endpointLabel,
  endpointTotal,
  errorTypeDistribution,
  nodeLabel,
  nodeSuccessRate,
  observabilityDailyMax,
  observabilityViewState,
  traceSummaryText,
} from "@/components/analytics/observability-scale";

describe("observability scale helpers", () => {
  it("computes node success rate with a safe zero denominator", () => {
    expect(nodeSuccessRate({ calls: 0, success: 0 } as never)).toBe(0);
    expect(nodeSuccessRate({ calls: 4, success: 3 } as never)).toBe(0.75);
  });

  it("keeps daily bar scales usable for empty data", () => {
    expect(observabilityDailyMax([])).toBe(1);
    expect(observabilityDailyMax([0, 3, 2])).toBe(3);
  });

  it("samples daily x-axis labels so a 180d range stays readable", () => {
    expect(dailyLabelStep(0)).toBe(1);
    expect(dailyLabelStep(7)).toBe(1);
    expect(dailyLabelStep(30)).toBe(3);
    expect(dailyLabelStep(180)).toBe(15);

    const count = 180;
    const step = dailyLabelStep(count);
    const visible = Array.from({ length: count }, (_, i) => i).filter(
      (i) => i % step === 0 || i === count - 1
    );
    expect(visible.length).toBeLessThanOrEqual(13);
  });

  it("resolves dotted endpoint keys through nested i18n paths", () => {
    const messages = {
      observabilityEndpoint: {
        match: "简历匹配",
        ai: { translate: "简历翻译" },
        jd: { image_ocr: "JD 图片识别" },
      },
    };
    // 复刻 i18n createTranslator 的 getByPath：按 "." 逐层取值，查不到返回 key
    const t = (key: string): string => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (acc, seg) =>
            acc != null && typeof acc === "object"
              ? (acc as Record<string, unknown>)[seg]
              : undefined,
          messages
        );
      return typeof value === "string" ? value : key;
    };
    expect(endpointLabel("match", t)).toBe("简历匹配");
    expect(endpointLabel("ai.translate", t)).toBe("简历翻译");
    expect(endpointLabel("jd.image_ocr", t)).toBe("JD 图片识别");
    expect(endpointLabel("unknown", t)).toBe("unknown");
  });

  it("sums endpoint call totals", () => {
    expect(
      endpointTotal([
        { calls: 3 } as never,
        { calls: 5 } as never,
      ])
    ).toBe(8);
  });

  it("sums node token attribution", () => {
    expect(
      costNodeTotal([
        { total_tokens: 100 } as never,
        { total_tokens: 250 } as never,
      ])
    ).toBe(350);
  });

  it("sorts error type distribution by count desc", () => {
    const dist = errorTypeDistribution({
      error_types: [
        ["TimeoutError", 1],
        ["ParseError", 3],
      ],
    } as never);
    expect(dist[0]).toEqual({ type: "ParseError", count: 3 });
    expect(dist[1]).toEqual({ type: "TimeoutError", count: 1 });
  });

  it("falls back to raw step_key when no translation exists", () => {
    const t = (key: string) => key;
    expect(nodeLabel("jd_extract", t)).toBe("jd_extract");
    const t2 = (key: string) =>
      key === "observabilityNode.jd_extract" ? "提取岗位要求" : key;
    expect(nodeLabel("jd_extract", t2)).toBe("提取岗位要求");
  });

  it("renders a trace summary with endpoint and time", () => {
    const t = (key: string) => key;
    const text = traceSummaryText(
      {
        endpoint: "match",
        started_at: "2026-11-05T09:30:00",
      } as never,
      t
    );
    expect(text).toContain("match");
    expect(text).toContain("11-05");
  });
});

describe("observabilityViewState", () => {
  it("stays in loading until the CURRENT filter has data", () => {
    // 切维度时组件会清空旧数据，不能把上一个维度的结果冒充当前结果。
    expect(
      observabilityViewState({
        loading: true,
        error: false,
        total: null,
        filtered: true,
      })
    ).toBe("loading");
    expect(
      observabilityViewState({
        loading: false,
        error: false,
        total: null,
        filtered: false,
      })
    ).toBe("loading");
  });

  it("surfaces request failure as retryable error, not as empty data", () => {
    expect(
      observabilityViewState({
        loading: false,
        error: true,
        total: null,
        filtered: true,
      })
    ).toBe("error");
  });

  it("distinguishes an empty filter from an entirely empty site", () => {
    // 回归：筛选到无数据维度时必须走 empty-filtered，
    // 该状态仍渲染常驻切换条并提供「查看全部」出口。
    expect(
      observabilityViewState({
        loading: false,
        error: false,
        total: 0,
        filtered: true,
      })
    ).toBe("empty-filtered");
    expect(
      observabilityViewState({
        loading: false,
        error: false,
        total: 0,
        filtered: false,
      })
    ).toBe("empty-all");
  });

  it("reports ready only when the current filter has calls", () => {
    expect(
      observabilityViewState({
        loading: false,
        error: false,
        total: 3,
        filtered: true,
      })
    ).toBe("ready");
  });
});
