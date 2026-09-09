import { DEFAULT_PAGE_PADDING } from "@/types/resume";

/**
 * 防御性规范化页面边距：任何消费方在把 pagePadding 用于渲染 / 分页 /
 * 打印版 HTML（printHtml.ts 的 buildPrintHtml）之前都应过一遍这里，
 * 防止 undefined / NaN / 负数等异常值破坏排版（历史 bug：缺失时被
 * `|| 0` 兜底成 0，导出 PDF 四边贴纸边）。
 *
 * 规则：number 且有限且 ≥ 0 时原样返回（保留用户显式设 0 的合法选择）；
 * 其余情况（undefined / NaN / 负数）回退到全局默认 DEFAULT_PAGE_PADDING。
 */
export const normalizePagePadding = (raw: number | undefined): number => {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_PAGE_PADDING;
};
