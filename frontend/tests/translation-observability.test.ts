/**
 * 翻译观测面板的纯函数测试（node 环境，无 jsdom）。
 *
 * 这些函数决定页面上最难自查的部分：柱子归一化、分组占比分母、以及列表摘要
 * 的文案分支——「旧记录无明细」若被渲染成「0 字段」，用户会读成「翻译了个寂寞」。
 */
import { describe, expect, it } from "vitest";

import {
  translationCallSummaryText,
  translationDailyMax,
  translationGroupTotal,
} from "@/components/analytics/translation-scale";
import type { TranslationSummary } from "@/lib/jobmatch";

const t = (key: string, values?: Record<string, string | number>) => {
  if (!values) return key;
  return `${key}:${JSON.stringify(values)}`;
};

describe("translationDailyMax", () => {
  it("空数组返回 1，避免除零与高度塌陷", () => {
    expect(translationDailyMax([])).toBe(1);
  });

  it("全零返回 1", () => {
    expect(translationDailyMax([0, 0, 0])).toBe(1);
  });

  it("取最大值，忽略非有限值", () => {
    expect(translationDailyMax([1, 9, 3, Number.NaN])).toBe(9);
  });
});

describe("translationGroupTotal", () => {
  it("求和作为占比分母", () => {
    expect(translationGroupTotal([{ count: 2 }, { count: 3 }])).toBe(5);
  });

  it("空分组返回 0", () => {
    expect(translationGroupTotal([])).toBe(0);
  });

  it("脏数据按 0 计，不让整条崩掉", () => {
    expect(
      translationGroupTotal([
        { count: 2 },
        { count: Number.NaN },
      ])
    ).toBe(2);
  });
});

describe("translationCallSummaryText", () => {
  const base: TranslationSummary = {
    target_lang: "en",
    fields_total: 12,
    fields_translated: 10,
    fields_unchanged: 2,
    fields_missing: 0,
  };

  it("有明细时显示字段数与未变化数", () => {
    expect(translationCallSummaryText(base, t)).toBe(
      'translationFieldsSummary:{"total":12,"unchanged":2}'
    );
  });

  it("无明细（观测上线前的旧记录）显式说明，而不是显示 0 字段", () => {
    expect(translationCallSummaryText(null, t)).toBe("translationNoDetail");
  });

  it("有明细但字段数为 0 时显示「无可译字段」", () => {
    expect(
      translationCallSummaryText({ ...base, fields_total: 0 }, t)
    ).toBe("translationNoFields");
  });
});
