/**
 * 投递统计图表的**纯函数**工具层：数值缩放、日期轴、序列整形。
 *
 * 刻意与渲染分离（不 import echarts、不碰 DOM），原因有二：
 * 1. 本项目 vitest 运行在 node 环境、无 jsdom，组件渲染无法单测，
 *    但这里的逻辑是真正容易算错的部分——把它抽出来才可测；
 * 2. 图表 option 构造复用同一套缩放口径，避免「趋势图与星期图各算各的」。
 */
import type { JobDailyPoint } from "@/lib/jobmatch";

/** ECharts 数值轴取整：计数类数据必须用整数刻度，禁止出现 0.5 个投递。 */
export const VALUE_AXIS_MIN_INTERVAL = 1;

/**
 * 求「好看」的坐标轴上限。
 *
 * 全零或空数据返回 1，保证：轴有刻度、除零不会发生、图表宽度不塌陷。
 * 取 1/2/2.5/5/10 × 10^n 中最小的 ≥ max 者。
 */
export function niceAxisMax(values: number[]): number {
  const max = values.reduce(
    (acc, v) => (Number.isFinite(v) && v > acc ? v : acc),
    0
  );
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (max <= step * base) return step * base;
  }
  return 10 * base;
}

/**
 * 计算 x 轴标签的抽稀间隔（ECharts `axisLabel.interval` 语义：0 = 全显示）。
 * 30 天以上必须抽稀，否则标签互相覆盖成灰色条带。
 */
export function axisLabelInterval(count: number, maxLabels = 8): number {
  if (count <= 0 || count <= maxLabels) return 0;
  return Math.ceil(count / maxLabels) - 1;
}

export interface DailySeries {
  dates: string[];
  created: number[];
  greeting: number[];
  resumeReady: number[];
  applied: number[];
  closed: number[];
  /** 回填日（日期为近似值）：图表以斜纹底纹区分 */
  backfill: boolean[];
}

/** 把后端 `daily` 数组整形成并列数组，供 ECharts 直接用。 */
export function buildDailySeries(daily: JobDailyPoint[]): DailySeries {
  const rows = Array.isArray(daily) ? daily : [];
  return {
    dates: rows.map((d) => d.date),
    created: rows.map((d) => d.created ?? 0),
    greeting: rows.map((d) => d.greeting ?? 0),
    resumeReady: rows.map((d) => d.resume_ready ?? 0),
    applied: rows.map((d) => d.applied ?? 0),
    closed: rows.map((d) => d.closed ?? 0),
    backfill: rows.map((d) => Boolean(d.backfill)),
  };
}

/** 区间内是否存在任何活动（用于判断显示图表还是空态文案）。 */
export function hasAnyActivity(series: DailySeries): boolean {
  return (
    series.created.some((v) => v > 0) ||
    series.applied.some((v) => v > 0) ||
    series.closed.some((v) => v > 0)
  );
}

/** 坐标轴刻度：紧凑的 MM-DD（等宽字体下对齐，与 locale 无关）。 */
export function formatAxisTick(iso: string): string {
  return iso.length >= 10 ? iso.slice(5) : iso;
}

/** 提示框日期：本地化可读格式（不引入 date-fns，避免为一行格式化增加依赖）。 */
export function formatDayLabel(iso: string, locale: string): string {
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return iso;
  const [y, m, d] = parts;
  if (locale.startsWith("zh")) return `${y}年${m}月${d}日`;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** 比例 → 百分比整数文案（四舍五入，保证 100% 不显示为 99.9%）。 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0%";
  const pct = Math.min(100, Math.round(rate * 100));
  return `${pct}%`;
}

/** 天数 → 保留 1 位小数的文案；null 表示尚无数据，由调用方显示占位符。 */
export function formatDays(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return value.toFixed(1);
}

/**
 * 星期分布归一化：后端返回长度恒为 7 的数组（周一…周日），
 * 但接口契约变更或异常数据不应让图表崩掉，故此处做长度与类型兜底。
 */
export function normalizeWeekday(weekday: number[] | undefined): number[] {
  const src = Array.isArray(weekday) ? weekday : [];
  return Array.from({ length: 7 }, (_, i) => {
    const v = src[i];
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
}

/** 找出星期分布中的峰值下标（0=周一）；全零返回 -1。 */
export function weekdayPeakIndex(weekday: number[]): number {
  let best = -1;
  let bestVal = 0;
  weekday.forEach((v, i) => {
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  });
  return best;
}

/**
 * 漏斗各级的「相对上一级的留存率」，用于在漏斗旁标注转化情况。
 * 首级为 undefined（无上一级）；上一级为 0 时返回 null（无意义，不显示 0%）。
 */
export function funnelStepRates(
  counts: number[]
): (number | null | undefined)[] {
  return counts.map((c, i) => {
    if (i === 0) return undefined;
    const prev = counts[i - 1];
    if (!Number.isFinite(prev) || prev <= 0) return null;
    return c / prev;
  });
}

/** 千分位数字（统计数字统一等宽 + 分组，便于竖向对比）。 */
export function formatCount(value: number, locale = "zh-CN"): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(locale.startsWith("zh") ? "zh-CN" : "en-US").format(
    value
  );
}
