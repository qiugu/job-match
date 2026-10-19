// 投递分析（Delivery Analytics）独立页：按日投递趋势、漏斗、存量分布与星期节奏。
// 数据口径由后端 /api/jobs/stats 统一计算（时区分桶、缺日补零），本页只做展示；
// 图表配色经 components/analytics/tokens.ts 从 .theme-xai 令牌运行时解析（Canvas 读不到 CSS 变量）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import { useRouter } from "@/lib/navigation";
import { BarChart3, Info, Loader2, RefreshCw, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ANALYTICS_DAYS,
  getJobStats,
  type AnalyticsDays,
  type JobStats,
  type JobStatus,
} from "@/lib/jobmatch";
import { EChart } from "@/components/analytics/EChart";
import { MatchingObservability } from "@/components/analytics/MatchingObservability";
import {
  buildDailyTrendOption,
  buildFunnelOption,
  buildStatusDonutOption,
  buildWeekdayOption,
} from "@/components/analytics/options";
import {
  buildDailySeries,
  formatCount,
  formatDays,
  formatRate,
  hasAnyActivity,
  normalizeWeekday,
  weekdayPeakIndex,
} from "@/components/analytics/scale";

/** KPI 数字卡：等宽大数字 + 眉题 + 补充口径说明。 */
function KpiCard({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="workbench-panel analytics-kpi analytics-panel p-5">
      <p className="xai-eyebrow text-[10px]">{label}</p>
      <p className="mt-2 flex items-baseline gap-1">
        <span className="font-mono text-[30px] font-semibold leading-none tracking-[-0.06em] text-xai-text">
          {value}
        </span>
        {unit && (
          <span className="text-[12px] text-xai-mute">{unit}</span>
        )}
      </p>
      {hint && (
        <p className="mt-3 truncate text-[11px] leading-5 text-xai-mute" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** 图表面板：眉题标题 + 图表内容。 */
function ChartPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="workbench-panel analytics-panel p-5">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-xai-text" aria-hidden="true" />
        <p className="xai-eyebrow text-[10px]">{title}</p>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** 区间选择白名单的展示文案键（与 ANALYTICS_DAYS 顺序无关，按值映射）。 */
const RANGE_LABEL_KEY: Record<number, string> = {
  7: "analyticsRange7",
  14: "analyticsRange14",
  30: "analyticsRange30",
  90: "analyticsRange90",
  180: "analyticsRange180",
  365: "analyticsRange365",
};

/** 环形图顺序：阶段推进顺序 + 终态分支，与后端 status_distribution 键集一致。 */
const STATUS_ORDER: JobStatus[] = [
  "greeting_sent",
  "resume_ready",
  "applied",
  "closed",
];

export default function AnalyticsPage() {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const router = useRouter();

  const [days, setDays] = useState<AnalyticsDays>(30);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /** 每次成功加载后 +1，驱动图表重绘（数据引用可能不变，但内容已更新） */
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<"delivery" | "matching">("delivery");
  const requestId = useRef(0);

  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "matching") {
      setTab("matching");
    }
  }, []);

  const changeTab = (next: "delivery" | "matching") => {
    setTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "matching") url.searchParams.set("tab", "matching");
      else url.searchParams.delete("tab");
      window.history.replaceState({}, "", url);
    }
  };

  const load = useCallback(
    async (range: AnalyticsDays) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(false);
      try {
        // 时区必须显式传：库里存 UTC，后端不假定用户时区（默认 UTC+8 仅为兜底）
        const data = await getJobStats(range, -new Date().getTimezoneOffset());
        if (id !== requestId.current) return; // 已有更新的请求，丢弃过期响应
        setStats(data);
        setRevision((r) => r + 1);
      } catch (err) {
        if (id !== requestId.current) return;
        console.error("加载投递统计失败:", err);
        setError(true);
        toast.error(t("analyticsLoadError"));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const series = stats ? buildDailySeries(stats.daily) : null;
  const weekday = normalizeWeekday(stats?.weekday);
  const weekdayPeak = weekdayPeakIndex(weekday);
  const cohortJobs = stats
    ? Object.values(stats.status_distribution).reduce((sum, count) => sum + count, 0)
    : 0;

  const rangeBar = (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-card p-1">
        {ANALYTICS_DAYS.map((d) => {
          const active = d === days;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                "h-7 rounded-full px-3 font-mono text-[11px] transition-colors duration-150",
                active
                  ? "bg-xai-text text-xai-canvas"
                  : "text-xai-mute hover:bg-xai-surface-2 hover:text-xai-text"
              )}
            >
              {t(RANGE_LABEL_KEY[d])}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="xai-pill-outline size-9 shrink-0"
        title={t("analyticsRefresh")}
        onClick={() => void load(days)}
      >
        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
      </button>
    </div>
  );

  return (
    <div className="workbench-page analytics-page flex h-full min-h-0 flex-col overflow-hidden bg-xai-canvas text-xai-text">
      {/* 顶部：标题 + 区间切换 + 刷新 */}
      <header className="workbench-header analytics-header flex min-h-[82px] shrink-0 items-center justify-between gap-4 border-b px-6 py-4 lg:px-8">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-xai-hairline bg-xai-surface-2 text-xai-text">
            <BarChart3 className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="xai-eyebrow mb-1 text-[10px]">DELIVERY DESK</p>
            <h1 className="truncate text-[17px] font-semibold tracking-[-0.03em] text-xai-text">
              {t("analyticsTitle")}
            </h1>
            <p className="truncate text-[12px] text-xai-mute">
              {t("analyticsSubtitle")}
            </p>
          </div>
        </div>
        <div className="flex max-w-full shrink-0 items-center gap-3 overflow-x-auto pb-0.5">
          <div className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-card p-1" role="tablist" aria-label={t("analyticsTabsLabel")}>
            {(["delivery", "matching"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => changeTab(key)}
                className={cn(
                  "h-7 rounded-full px-3 text-[11px] transition-colors duration-150",
                  tab === key ? "bg-xai-text text-xai-canvas" : "text-xai-mute hover:bg-xai-surface-2 hover:text-xai-text"
                )}
              >
                {t(key === "delivery" ? "analyticsTabDelivery" : "analyticsTabMatching")}
              </button>
            ))}
          </div>
          {rangeBar}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-5 sm:px-6 lg:px-8">
        {tab === "matching" ? (
          <MatchingObservability days={days} />
        ) : loading && !stats ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("analyticsLoading")}
          </div>
        ) : error && !stats ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-[13px] text-muted-foreground">
              {t("analyticsLoadError")}
            </p>
            <button
              type="button"
              className="xai-pill-primary"
              onClick={() => void load(days)}
            >
              <RefreshCw className="size-3.5" />
              {t("analyticsRetry")}
            </button>
          </div>
        ) : !stats || !series ? null : stats.totals.jobs === 0 ? (
          /* 全空态：连一张岗位卡都没有，引导去匹配页开始第一家 */
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-[14px] font-medium text-xai-text-mid">
              {t("analyticsEmptyTitle")}
            </p>
            <p className="max-w-md text-[13px] leading-relaxed text-xai-mute">
              {t("analyticsEmptyDesc")}
            </p>
            <button
              type="button"
              className="xai-pill-primary mt-1"
              onClick={() => router.push("/app/dashboard/match")}
            >
              <Tag className="size-3.5" />
              {t("jobPageNewMatch")}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* KPI 条 */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
              <KpiCard
                label={t("kpiAppliedEver")}
                value={formatCount(stats.totals.applied_ever, locale)}
                hint={`${t("kpiActiveLabel")} ${formatCount(stats.totals.active_now, locale)} · ${t("kpiArchivedLabel")} ${formatCount(stats.totals.closed_now, locale)}`}
              />
              <KpiCard
                label={t("kpiAppliedRate")}
                value={formatRate(stats.totals.applied_rate)}
                hint={`${formatCount(stats.totals.applied_ever, locale)} / ${formatCount(stats.totals.jobs, locale)}`}
              />
              <KpiCard
                label={t("kpiAvgDays")}
                value={
                  formatDays(stats.totals.avg_days_to_apply) ?? "—"
                }
                unit={stats.totals.avg_days_to_apply !== null ? t("kpiUnitDays") : undefined}
                hint={t("kpiAvgDaysHint")}
              />
              <KpiCard
                label={t("kpiStreak")}
                value={formatCount(stats.streak.current, locale)}
                unit={t("kpiUnitDays")}
                hint={`${t("kpiStreakBest")} ${formatCount(stats.streak.best, locale)} ${t("kpiUnitDays")}`}
              />
            </div>

            {/* 每日趋势（全宽） */}
            <ChartPanel title={t("chartDailyTrend")}>
              {hasAnyActivity(series) ? (
                <>
                  <EChart
                    height={264}
                    ariaLabel={t("chartDailyTrend")}
                    revision={revision}
                    build={(tokens) =>
                      buildDailyTrendOption({
                        series,
                        tokens,
                        locale,
                        labels: {
                          created: t("labelCreated"),
                          applied: t("labelApplied"),
                          backfill: t("labelBackfill"),
                        },
                      })
                    }
                  />
                  {stats.totals.backfilled_jobs > 0 && (
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-xai-mute">
                      <Info className="size-3 shrink-0" />
                      {t("analyticsBackfillNote")}
                    </p>
                  )}
                </>
              ) : (
                <div className="flex h-[264px] items-center justify-center text-[13px] text-xai-mute">
                  {t("chartEmptyRange")}
                </div>
              )}
            </ChartPanel>

            {/* 漏斗（累计到达口径）+ 存量状态分布 */}
            <div className="grid gap-4 xl:grid-cols-5">
              <div className="xl:col-span-3">
                <ChartPanel title={t("chartFunnel")}>
                  <EChart
                    height={216}
                    ariaLabel={t("chartFunnel")}
                    revision={revision}
                    build={(tokens) =>
                      buildFunnelOption({
                        funnel: stats.funnel,
                        tokens,
                        labels: {
                          created: t("funnelCreated"),
                          resume_ready: t("funnelResumeReady"),
                          applied: t("funnelApplied"),
                        },
                      })
                    }
                  />
                </ChartPanel>
              </div>
              <div className="xl:col-span-2">
                <ChartPanel title={t("chartStatus")}>
                  <div className="relative">
                    <EChart
                      height={216}
                      ariaLabel={t("chartStatus")}
                      revision={revision}
                      build={(tokens) =>
                        buildStatusDonutOption({
                          distribution: stats.status_distribution,
                          order: STATUS_ORDER,
                          labels: {
                            greeting_sent: t("jobStatusGreetingSent"),
                            resume_ready: t("jobStatusResumeReady"),
                            applied: t("jobStatusApplied"),
                            closed: t("jobStatusClosed"),
                          },
                          tokens,
                        })
                      }
                    />
                    {/* 环心总数：与 series.center 的 44% 对齐 */}
                    <div
                      className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 text-center"
                      style={{ top: "44%" }}
                    >
                      <p className="font-mono text-[22px] leading-none tracking-tight text-xai-text">
                        {formatCount(cohortJobs, locale)}
                      </p>
                      <p className="mt-1 text-[10px] text-xai-mute">
                        {t("chartStatusCenter")}
                      </p>
                    </div>
                  </div>
                </ChartPanel>
              </div>
            </div>

            {/* 星期分布（全宽）：峰值用强调色 */}
            <ChartPanel title={t("chartWeekday")}>
              <EChart
                height={200}
                ariaLabel={t("chartWeekday")}
                revision={revision}
                build={(tokens) =>
                  buildWeekdayOption({
                    weekday,
                    tokens,
                    peakIndex: weekdayPeak,
                    labels: [
                      t("weekdayMon"),
                      t("weekdayTue"),
                      t("weekdayWed"),
                      t("weekdayThu"),
                      t("weekdayFri"),
                      t("weekdaySat"),
                      t("weekdaySun"),
                    ],
                  })
                }
              />
            </ChartPanel>
          </div>
        )}
      </div>
    </div>
  );
}
