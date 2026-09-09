import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_PADDING } from "@/types/resume";
import { normalizePagePadding } from "@/utils/pagePadding";
import { initialResumeState, initialResumeStateEn } from "@/config/initialResumeData";

/**
 * PDF 导出页边距回归测试（2026-09-09 修复）：
 * 历史 bug —— globalSettings.pagePadding 缺失（JD 匹配流生成的简历不带该字段）
 * 时被 `|| 0` 兜底为 0，html2pdf margin=0 导致 PDF 四边贴纸边。
 * html2pdf 现已退役，导出与打印共用 printHtml.ts 的 buildPrintHtml 渲染
 * 同一份 print HTML；消费端一律 `?? DEFAULT_PAGE_PADDING`、数值进导出前经
 * normalizePagePadding 防御的约定不变。本文件钉住该约定，防止回归。
 */
describe("DEFAULT_PAGE_PADDING 单一事实源", () => {
  it("默认页边距为 48px（= 0.5 inch = 12.7mm，A4 @96dpi，简历通行下限）", () => {
    expect(DEFAULT_PAGE_PADDING).toBe(48);
    // 换算自洽：1px = 25.4/96 mm，48px 应约为 12.7mm
    expect(DEFAULT_PAGE_PADDING * (25.4 / 96)).toBeCloseTo(12.7, 1);
  });

  it("新建简历初始 globalSettings.pagePadding 与常量同源", () => {
    expect(initialResumeState.globalSettings.pagePadding).toBe(
      DEFAULT_PAGE_PADDING
    );
    expect(initialResumeStateEn.globalSettings.pagePadding).toBe(
      DEFAULT_PAGE_PADDING
    );
  });
});

describe("normalizePagePadding 防御性规范化", () => {
  it("undefined（字段缺失的历史 bug 场景）回退到默认值", () => {
    expect(normalizePagePadding(undefined)).toBe(DEFAULT_PAGE_PADDING);
  });

  it("NaN / 负数等异常值回退到默认值", () => {
    expect(normalizePagePadding(NaN)).toBe(DEFAULT_PAGE_PADDING);
    expect(normalizePagePadding(-1)).toBe(DEFAULT_PAGE_PADDING);
    expect(normalizePagePadding(-Infinity)).toBe(DEFAULT_PAGE_PADDING);
  });

  it("有效值原样返回（含用户显式设 0 的合法全出血选择）", () => {
    expect(normalizePagePadding(0)).toBe(0);
    expect(normalizePagePadding(16)).toBe(16);
    expect(normalizePagePadding(DEFAULT_PAGE_PADDING)).toBe(DEFAULT_PAGE_PADDING);
    expect(normalizePagePadding(72)).toBe(72);
    expect(normalizePagePadding(100)).toBe(100);
  });
});
