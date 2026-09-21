import type { MatchQuality } from "@/lib/jobmatch";

export function matchingSuccessRate(success: number, total: number): number {
  return total > 0 ? success / total : 0;
}

export function matchingQualityTotal(quality: MatchQuality): number {
  return quality.matched + quality.weak + quality.missing + quality.unsupported;
}

export function matchingDailyMax(values: number[]): number {
  return Math.max(1, ...values.filter(Number.isFinite));
}

export function formatMatchingDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}
