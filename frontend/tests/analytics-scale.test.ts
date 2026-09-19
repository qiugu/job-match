/**
 * 投递分析纯函数回归测试（scale.ts + options.ts）。
 *
 * 这两处是统计页最容易算错的部分：数值缩放、日期轴抽稀、漏斗口径与
 * option 结构契约。vitest 运行在 node 环境（无 jsdom），因此刻意要求
 * options.ts 只做 `import type echarts`——若有人改成运行时 import，
 * 本文件会在 node 下直接失败，等于锁住了「逻辑层不依赖 DOM」的约束。
 */
import { describe, expect, it } from "vitest";

import type { JobStats } from "@/lib/jobmatch";
import {
  axisLabelInterval,
  buildDailySeries,
  formatAxisTick,
  formatCount,
  formatDayLabel,
  formatDays,
  formatRate,
  funnelStepRates,
  hasAnyActivity,
  niceAxisMax,
  normalizeWeekday,
  weekdayPeakIndex,
  type DailySeries,
} from "@/components/analytics/scale";
import {
  buildDailyTrendOption,
  buildFunnelOption,
  buildStatusDonutOption,
  buildWeekdayOption,
} from "@/components/analytics/options";
import { FALLBACK_TOKENS, mixHex, stageColor } from "@/components/analytics/tokens";

const TOKENS = FALLBACK_TOKENS;

const sampleSeries: DailySeries = {
  dates: ["2026-09-14", "2026-09-15", "2026-09-16"],
  created: [2, 0, 1],
  greeting: [1, 0, 0],
  resumeReady: [0, 1, 0],
  applied: [0, 0, 1],
  closed: [0, 0, 0],
  backfill: [false, true, false],
};

describe("scale / niceAxisMax", () => {
  it("空与全零返回 1（保证轴存在刻度且不除零）", () => {
    expect(niceAxisMax([])).toBe(1);
    expect(niceAxisMax([0, 0, 0])).toBe(1);
  });

  it("取 1/2/2.5/5/10 × 10^n 中最小的 ≥ max 者", () => {
    expect(niceAxisMax([3])).toBe(5);
    expect(niceAxisMax([7])).toBe(10);
    expect(niceAxisMax([1])).toBe(1);
    expect(niceAxisMax([100])).toBe(100);
    expect(niceAxisMax([0.3])).toBe(0.5);
  });

  it("忽略非法值", () => {
    expect(niceAxisMax([NaN, 2, Infinity])).toBe(2);
  });
});

describe("scale / axisLabelInterval", () => {
  it("少量标签全显示（0 = ECharts 语义的全显示）", () => {
    expect(axisLabelInterval(0)).toBe(0);
    expect(axisLabelInterval(8)).toBe(0);
  });

  it("超量抽稀到约 8 个标签", () => {
    expect(axisLabelInterval(30, 8)).toBe(Math.ceil(30 / 8) - 1);
    expect(axisLabelInterval(90, 8)).toBe(Math.ceil(90 / 8) - 1);
  });
});

describe("scale / buildDailySeries", () => {
  it("按字段整形成并列数组，backfill 强转布尔", () => {
    const s = buildDailySeries([
      {
        date: "2026-09-14",
        created: 2,
        greeting: 1,
        resume_ready: 0,
        applied: 0,
        closed: 0,
        backfill: false,
      },
      {
        date: "2026-09-15",
        created: 0,
        greeting: 0,
        resume_ready: 1,
        applied: 0,
        closed: 0,
        backfill: true,
      },
    ]);
    expect(s.dates).toEqual(["2026-09-14", "2026-09-15"]);
    expect(s.created).toEqual([2, 0]);
    expect(s.backfill).toEqual([false, true]);
  });

  it("非数组输入得到全空序列（接口异常不崩页）", () => {
    const s = buildDailySeries(undefined as never);
    expect(s.dates).toEqual([]);
    expect(s.applied).toEqual([]);
  });
});

describe("scale / 口径与格式化", () => {
  it("hasAnyActivity 只看建卡/投递/归档", () => {
    expect(hasAnyActivity(sampleSeries)).toBe(true);
    expect(
      hasAnyActivity({
        ...sampleSeries,
        created: [0, 0, 0],
        applied: [0, 0, 0],
        closed: [0, 0, 0],
      })
    ).toBe(false);
  });

  it("formatRate 不产生 99.9% 一类舍入伪影", () => {
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(0.999)).toBe("100%");
    expect(formatRate(0.25)).toBe("25%");
    expect(formatRate(NaN)).toBe("0%");
  });

  it("formatDays：null 通过 nil 传递，数值保留 1 位小数", () => {
    expect(formatDays(null)).toBeNull();
    expect(formatDays(undefined)).toBeNull();
    expect(formatDays(3.25)).toBe("3.3");
  });

  it("formatAxisTick 取 MM-DD", () => {
    expect(formatAxisTick("2026-09-16")).toBe("09-16");
  });

  it("formatDayLabel 中英文分支", () => {
    expect(formatDayLabel("2026-09-16", "zh")).toBe("2026年9月16日");
    expect(formatDayLabel("2026-09-16", "en")).toMatch(/Sep/);
  });

  it("formatCount 千分位", () => {
    expect(formatCount(1234, "zh")).toBe("1,234");
    expect(formatCount(1234, "en")).toBe("1,234");
  });

  it("normalizeWeekday 兜底长度恒为 7", () => {
    expect(normalizeWeekday(undefined)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(normalizeWeekday([1, -2, 3.9])).toEqual([1, 0, 3.9, 0, 0, 0, 0]);
  });

  it("weekdayPeakIndex 找峰值，全零返回 -1", () => {
    expect(weekdayPeakIndex([0, 2, 5, 1, 0, 0, 0])).toBe(2);
    expect(weekdayPeakIndex([0, 0, 0, 0, 0, 0, 0])).toBe(-1);
  });

  it("funnelStepRates：首级无比率，上级为 0 返回 null", () => {
    expect(funnelStepRates([10, 5, 2])).toEqual([undefined, 0.5, 0.4]);
    expect(funnelStepRates([0, 3])).toEqual([undefined, null]);
  });
});

describe("tokens / 单色阶", () => {
  it("投递分析使用高对比珊瑚强调色，而不是低辨识度靛蓝", () => {
    expect(TOKENS.surface).toBe("#FFFDF8");
    expect(TOKENS.text).toBe("#17233C");
    expect(stageColor("applied", TOKENS)).toBe("#E85D4A");
  });

  it("mixHex 端点与中点", () => {
    expect(mixHex("#E85D4A", "#17233C", 0)).toBe("#e85d4a");
    expect(mixHex("#E85D4A", "#17233C", 1)).toBe("#17233c");
    expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
  });

  it("非法输入不抛错（回退为 a）", () => {
    expect(mixHex("not-a-color", "#000000", 0.5)).toBe("not-a-color");
  });

  it("阶段色：applied 为满强调色，closed 为中性色（不参与色阶）", () => {
    expect(stageColor("applied", TOKENS)).toBe("#E85D4A");
    expect(stageColor("closed", TOKENS)).not.toBe("#5E6AD2");
  });
});

describe("options / 结构契约", () => {
  it("每日趋势：双柱序列 + 类目轴日期数一致", () => {
    const opt = buildDailyTrendOption({
      series: sampleSeries,
      tokens: TOKENS,
      locale: "zh",
      labels: { created: "新建机会", applied: "确认投递", backfill: "回填" },
    }) as {
      series: { type: string; data: number[]; markArea?: unknown }[];
      xAxis: { data: string[] };
    };
    expect(opt.series).toHaveLength(2);
    expect(opt.series[0].data).toEqual(sampleSeries.created);
    expect(opt.series[1].data).toEqual(sampleSeries.applied);
    expect(opt.xAxis.data).toEqual(sampleSeries.dates);
    // 回填日以 markArea 色带表达
    expect((opt.series[0].markArea as { data: unknown[] }).data).toHaveLength(1);
  });

  it("漏斗：类目轴自下而上 ⇒ 反转后顶部为「新建机会」", () => {
    const opt = buildFunnelOption({
      funnel: [
        { key: "created", count: 10, rate: 1 },
        { key: "resume_ready", count: 6, rate: 0.6 },
        { key: "applied", count: 4, rate: 0.4 },
      ],
      tokens: TOKENS,
      labels: { created: "新建机会", resume_ready: "已定制简历", applied: "已投递" },
    }) as {
      yAxis: { data: string[] };
      series: { data: { value: number }[] }[];
    };
    expect(opt.yAxis.data).toEqual(["已投递", "已定制简历", "新建机会"]);
    expect(opt.series[0].data.map((d) => d.value)).toEqual([4, 6, 10]);
  });

  it("状态环形：内置图例 + 四段数据", () => {
    const opt = buildStatusDonutOption({
      distribution: { greeting_sent: 3, resume_ready: 2, applied: 1, closed: 4 },
      order: ["greeting_sent", "resume_ready", "applied", "closed"],
      labels: {
        greeting_sent: "待回复",
        resume_ready: "待投递",
        applied: "已投递",
        closed: "已结束",
      },
      tokens: TOKENS,
    }) as {
      legend: Record<string, unknown>;
      series: { data: { name: string; value: number }[] }[];
    };
    expect(opt.legend).toBeTruthy();
    expect(opt.series[0].data.map((d) => d.value)).toEqual([3, 2, 1, 4]);
  });

  it("星期分布：峰值柱用强调色", () => {
    const opt = buildWeekdayOption({
      weekday: [1, 0, 3, 0, 0, 0, 0],
      tokens: TOKENS,
      peakIndex: 2,
      labels: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    }) as { series: { data: { itemStyle: { color: string } }[] }[] };
    expect(opt.series[0].data[2].itemStyle.color).toBe("#E85D4A");
    expect(opt.series[0].data[0].itemStyle.color).not.toBe("#E85D4A");
  });
});

/**
 * 类型契约守护：前端 JobStats 关键字段若被改名，这里在编译期即报错
 * （运行时只做最小断言，真正的口径由后端测试 test_job_stats.py 锁定）。
 */
describe("契约 / JobStats 形状", () => {
  it("funnel 键集与 weekday 长度符合页面假设", () => {
    const stats = {
      funnel: [
        { key: "created", count: 0, rate: 0 },
        { key: "resume_ready", count: 0, rate: 0 },
        { key: "applied", count: 0, rate: 0 },
      ],
      weekday: [0, 0, 0, 0, 0, 0, 0],
    } as unknown as Pick<JobStats, "funnel" | "weekday">;
    expect(stats.funnel.map((s) => s.key)).toEqual([
      "created",
      "resume_ready",
      "applied",
    ]);
    expect(stats.weekday).toHaveLength(7);
  });
});
