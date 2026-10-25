/**
 * 投递统计各图表的 ECharts option 构造。
 *
 * 设计约定：
 * - 所有颜色来自 `ChartTokens`（运行时解析自 `.theme-xai` + 纸墨令牌），**不硬编码**；
 * - 阶段是有序量 ⇒ 用钴蓝**单色阶**而非多分类色；
 * - 计数类数值轴一律 `minInterval: 1`，避免出现「0.5 个投递」这类不可能刻度；
 * - 只在类型层面依赖 echarts（`import type`），因此本模块可在 node 环境直接单测。
 */
import type { BarSeriesOption, EChartsOption } from "echarts";

import type { JobFunnelStage, JobStatus } from "@/lib/jobmatch";

import {
  axisColors,
  mixHex,
  stageColor,
  type ChartTokens,
} from "./tokens";
import {
  VALUE_AXIS_MIN_INTERVAL,
  axisLabelInterval,
  formatAxisTick,
  formatCount,
  formatDayLabel,
  formatRate,
  niceAxisMax,
  type DailySeries,
} from "./scale";

/** 日期类 x 轴/类目轴标签的抽稀上限，超过则由 ECharts 自动抽稀。 */
const MAX_AXIS_LABELS = 8;

/** 提示框字号（与正文 12px 对齐，深浅主题都用令牌，保证可读）。 */
const TOOLTIP_FONT_SIZE = 12;

/** ECharts 提示框参数：只声明用到的字段，避免依赖 echarts 内部类型路径。 */
interface TooltipItem {
  axisValue?: string;
  seriesName?: string;
  value?: unknown;
  dataIndex?: number;
}

/** 把 echarts 传入的单体/数组参数统一成对象数组。 */
function toItems(params: unknown): TooltipItem[] {
  if (Array.isArray(params)) return params as TooltipItem[];
  if (params && typeof params === "object") return [params as TooltipItem];
  return [];
}

function tooltipBase(tokens: ChartTokens) {
  return {
    backgroundColor: tokens.surface,
    borderColor: tokens.hairline,
    borderWidth: 1,
    padding: [8, 10] as [number, number],
    textStyle: {
      color: tokens.textMid,
      fontSize: TOOLTIP_FONT_SIZE,
      fontFamily: tokens.fontSans,
    },
  };
}

/** 统一的数值轴配置：无轴线、仅横向 hairline 分隔线。 */
function valueAxis(tokens: ChartTokens, max: number) {
  const c = axisColors(tokens);
  return {
    type: "value" as const,
    max,
    minInterval: VALUE_AXIS_MIN_INTERVAL,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: c.split, type: "solid" as const } },
    axisLabel: {
      color: c.label,
      fontSize: 11,
      fontFamily: tokens.fontMono,
    },
  };
}

/** 统一的类目轴配置（日期轴：等宽字体 + 抽稀 + 与首尾留白）。 */
function categoryAxis(tokens: ChartTokens, dates: string[]) {
  const c = axisColors(tokens);
  return {
    type: "category" as const,
    data: dates,
    boundaryGap: true,
    axisLine: { lineStyle: { color: c.line } },
    axisTick: { show: false },
    axisLabel: {
      color: c.label,
      fontSize: 11,
      fontFamily: tokens.fontMono,
      interval: axisLabelInterval(dates.length, MAX_AXIS_LABELS),
      formatter: (v: string) => formatAxisTick(v),
      hideOverlap: true,
    },
  };
}

/**
 * 回填日标注：以 1 个类目宽度的浅色色带覆盖。
 *
 * 用「色带」而不是通用的斜纹（decal）或改变柱色：色带是背景层，
 * 不参与数据编码，因此不会被误读为某个数值；柱色则应严格表示数值。
 * ECharts 的 markArea.data 每项是 [起点, 终点] **二元组**，须按元组类型声明。
 */
type MarkAreaRange = [{ xAxis: string }, { xAxis: string }];

function backfillAreas(series: DailySeries): MarkAreaRange[] {
  const areas: MarkAreaRange[] = [];
  series.backfill.forEach((flag, i) => {
    if (flag && series.dates[i]) {
      areas.push([{ xAxis: series.dates[i] }, { xAxis: series.dates[i] }]);
    }
  });
  return areas;
}

/**
 * 每日投递趋势：并列双序列。
 *
 * 「确认投递」用品牌强调色（主序列，读者最先要找的量）；
 * 「新建机会」用中性浅灰（上下文量，不应与主序列争夺注意力）。
 */
export function buildDailyTrendOption(params: {
  series: DailySeries;
  tokens: ChartTokens;
  locale: string;
  labels: {
    created: string;
    applied: string;
    backfill: string;
  };
}): EChartsOption {
  const { series, tokens, locale, labels } = params;
  const axisMax = niceAxisMax([...series.created, ...series.applied]);
  const neutral = mixHex(tokens.mute, tokens.surface, 0.62);

  return {
    grid: { left: 4, right: 8, top: 12, bottom: 0, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      ...tooltipBase(tokens),
      formatter: (params: unknown) => {
        const items = toItems(params);
        const idx = items[0]?.dataIndex ?? -1;
        if (idx < 0) return "";
        const lines = [`<span style="color:${tokens.text}">${formatDayLabel(series.dates[idx], locale)}</span>`];
        lines.push(`${labels.created} · ${series.created[idx] ?? 0}`);
        lines.push(`${labels.applied} · ${series.applied[idx] ?? 0}`);
        if (series.backfill[idx]) {
          lines.push(
            `<span style="color:${tokens.eyebrow}">${labels.backfill}</span>`
          );
        }
        return lines.join("<br/>");
      },
    },
    xAxis: categoryAxis(tokens, series.dates),
    yAxis: valueAxis(tokens, axisMax),
    // 显式标注：两个柱序列对象形状不同（其一含 markArea），
    // 联合推断无法直接赋给 EChartsOption 的 series 字段
    series: [
      {
        name: labels.created,
        type: "bar",
        data: series.created,
        barMaxWidth: 10,
        barGap: "15%",
        itemStyle: { color: neutral, borderRadius: [2, 2, 0, 0] },
        markArea: {
          silent: true,
          itemStyle: { color: mixHex(tokens.mute, tokens.surface, 0.82) },
          data: backfillAreas(series),
        },
      } satisfies BarSeriesOption,
      {
        name: labels.applied,
        type: "bar",
        data: series.applied,
        barMaxWidth: 10,
        itemStyle: { color: tokens.cobalt, borderRadius: [2, 2, 0, 0] },
      } satisfies BarSeriesOption,
    ],
    animationDuration: 520,
    animationEasing: "cubicOut",
    // 逐日错开入场，形成从左到右「生长」的节奏（单次，不循环）
    animationDelay: (idx: number) => Math.min(idx * 14, 420),
  };
}

/**
 * 漏斗：横向条，自下而上为「新建机会 → 已定制简历 → 已投递」。
 *
 * 后端给的是**累计到达**口径（各级单调不增），因此条长可比、可直接读出逐级流失。
 */
export function buildFunnelOption(params: {
  funnel: JobFunnelStage[];
  tokens: ChartTokens;
  labels: Record<JobFunnelStage["key"], string>;
}): EChartsOption {
  const { funnel, tokens, labels } = params;
  // ECharts 类目轴自下而上排列 ⇒ 反转，使「新建机会」出现在顶部
  const stages = [...funnel].reverse();
  const top = funnel[0]?.count ?? 0;

  return {
    grid: { left: 4, right: 84, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "item",
      ...tooltipBase(tokens),
      formatter: (params: unknown) => {
        const item = toItems(params)[0];
        const raw = item?.value;
        const count = typeof raw === "number" ? raw : 0;
        return `${labels[stagesForName(stages, item?.dataIndex)] ?? ""} · ${formatCount(count)}`;
      },
    },
    xAxis: {
      type: "value",
      show: false,
      max: top > 0 ? top : 1,
      minInterval: VALUE_AXIS_MIN_INTERVAL,
    },
    yAxis: {
      type: "category",
      data: stages.map((s) => labels[s.key]),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: tokens.textMid,
        fontSize: 12,
        fontFamily: tokens.fontSans,
      },
    },
    series: [
      {
        type: "bar",
        barWidth: 14,
        data: stages.map((s) => ({
          value: s.count,
          itemStyle: {
            color: stageColor(s.key as JobStatus, tokens),
            borderRadius: [0, 3, 3, 0],
          },
        })),
        label: {
          show: true,
          position: "right",
          distance: 8,
          color: tokens.textMid,
          fontSize: 12,
          fontFamily: tokens.fontMono,
          formatter: (p: { dataIndex?: number; value?: unknown }) => {
            const i = p.dataIndex ?? 0;
            const stage = stages[i];
            if (!stage) return "";
            return `${formatCount(stage.count)}  ${formatRate(stage.rate)}`;
          },
        },
      },
    ],
    animationDuration: 560,
    animationEasing: "cubicOut",
    animationDelay: (idx: number) => idx * 80,
  };
}

/** 取反转后第 i 级对应的键（提示框用）。 */
function stagesForName(
  stages: JobFunnelStage[],
  index: number | undefined
): JobFunnelStage["key"] {
  const s = stages[index ?? 0];
  return s ? s.key : "created";
}

/**
 * 存量状态分布环形图。
 *
 * 不画扇区内标签（4 段中的窄段放不下）——状态名与数值由 ECharts 内置图例
 * 承载（textStyle 全部走令牌），环形中心的总数由页面用 HTML 叠加，
 * 避免为标题引入额外的 ECharts 组件注册。
 */
export function buildStatusDonutOption(params: {
  distribution: Record<JobStatus, number>;
  order: JobStatus[];
  labels: Record<JobStatus, string>;
  tokens: ChartTokens;
}): EChartsOption {
  const { distribution, order, labels, tokens } = params;
  return {
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      // 图例是语义文字，用正文色而非静音色，保证双主题下的可读性
      textStyle: {
        color: tokens.textMid,
        fontSize: 12,
        fontFamily: tokens.fontSans,
      },
    },
    tooltip: {
      trigger: "item",
      ...tooltipBase(tokens),
      formatter: (params: unknown) => {
        const item = toItems(params)[0];
        const raw = item?.value;
        const count = typeof raw === "number" ? raw : 0;
        return `${item?.seriesName ?? ""} · ${formatCount(count)}`;
      },
    },
    series: [
      {
        type: "pie",
        // 底部留出图例高度，环形整体上移
        radius: ["58%", "82%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        // 段间以面板底色留白分隔，符合本项目「靠描边与留白分层、不用阴影」的语言
        itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
        emphasis: { scale: false },
        data: order.map((s) => ({
          name: labels[s],
          value: distribution[s] ?? 0,
          itemStyle: { color: stageColor(s, tokens) },
        })),
      },
    ],
    animationDuration: 560,
    animationEasing: "cubicOut",
  };
}

/** 星期分布：强调峰值，其余降低明度，一眼看出「习惯在周几投」。 */
export function buildWeekdayOption(params: {
  weekday: number[];
  tokens: ChartTokens;
  labels: string[];
  peakIndex: number;
}): EChartsOption {
  const { weekday, tokens, labels, peakIndex } = params;
  const accentSoft = mixHex(tokens.cobalt, tokens.surface, 0.45);

  return {
    grid: { left: 4, right: 8, top: 20, bottom: 0, containLabel: true },
    tooltip: {
      trigger: "item",
      ...tooltipBase(tokens),
      formatter: (params: unknown) => {
        const item = toItems(params)[0];
        const idx = item?.dataIndex ?? 0;
        return `${labels[idx] ?? ""} · ${formatCount(weekday[idx] ?? 0)}`;
      },
    },
    xAxis: {
      type: "category",
      data: labels,
      axisLine: { lineStyle: { color: axisColors(tokens).line } },
      axisTick: { show: false },
      axisLabel: {
        color: tokens.mute,
        fontSize: 12,
        fontFamily: tokens.fontSans,
        interval: 0,
      },
    },
    yAxis: valueAxis(tokens, niceAxisMax(weekday)),
    series: [
      {
        type: "bar",
        barMaxWidth: 26,
        data: weekday.map((v, i) => ({
          value: v,
          itemStyle: {
            color: i === peakIndex && v > 0 ? tokens.cobalt : accentSoft,
            borderRadius: [3, 3, 0, 0],
          },
        })),
        label: {
          show: true,
          position: "top",
          color: tokens.mute,
          fontSize: 11,
          fontFamily: tokens.fontMono,
          formatter: (p: { value?: unknown }) =>
            typeof p.value === "number" && p.value > 0 ? String(p.value) : "",
        },
      },
    ],
    animationDuration: 480,
    animationEasing: "cubicOut",
    animationDelay: (idx: number) => idx * 45,
  };
}
