/**
 * 翻译观测面板的**纯函数**层（可 node 单测，无 DOM 依赖）。
 *
 * 与 `matching-scale.ts` / `scale.ts` 同一定位：组件在 node 环境的 vitest 里无法
 * 渲染，所以把真正容易算错的部分（归一、分母、文案分支）抽成纯函数。
 */
import type { TranslationSummary } from "@/lib/jobmatch";

/** 柱状图归一化的分母：全零或空数组返回 1，避免除零与高度塌陷。 */
export function translationDailyMax(values: number[]): number {
  return Math.max(1, ...values.filter(Number.isFinite));
}

/** 未变化分组的总数（分组占比条的分母）；脏数据按 0 计，不让整条干掉。 */
export function translationGroupTotal(
  groups: Array<{ count: number }>
): number {
  return groups.reduce(
    (acc, item) => acc + (Number.isFinite(item.count) ? item.count : 0),
    0
  );
}

export type TranslateFn = (
  key: string,
  values?: Record<string, string | number>
) => string;

/**
 * 调用列表的行摘要。
 *
 * 三种情况必须分开，否则会误导：
 * - 有明细 → 「12 字段 / 2 未变化」；
 * - 旧记录（观测上线前）→ 明说「无明细」，而不是显示「0 字段」，让人以为没翻译；
 * - 有明细但字段数为 0 → 「无可译字段」（几乎只出现在空简历上）。
 */
export function translationCallSummaryText(
  summary: TranslationSummary | null,
  t: TranslateFn
): string {
  if (!summary) return t("translationNoDetail");
  if (summary.fields_total <= 0) return t("translationNoFields");
  return t("translationFieldsSummary", {
    total: summary.fields_total,
    unchanged: summary.fields_unchanged,
  });
}
