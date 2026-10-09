import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  FileText,
  GitBranch,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/compat/client";
import { cn } from "@/lib/utils";
import {
  AdminRange,
  fetchAdminDashboard,
  growthConversionRate,
  type AdminDashboard,
} from "@/lib/admin";
import { EChart } from "@/components/analytics/EChart";
import { useAuthStore } from "@/store/useAuthStore";
import type { ChartTokens } from "@/components/analytics/tokens";
import type { EChartsOption } from "echarts";

const RANGES: AdminRange[] = [7, 30, 90];
const BRAND_ACCENT = "#E85D4A";
type MetricIcon = typeof Activity;

function MetricCard({
  label,
  value,
  note,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: number;
  note: string;
  icon: MetricIcon;
  accent?: boolean;
}) {
  return (
    <div className="group rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 transition-colors duration-200 hover:border-xai-hairline-strong sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="xai-eyebrow text-[10px]">{label}</p>
        <span className={cn("flex size-7 items-center justify-center rounded-lg border", accent ? "border-[#E85D4A]/25 bg-[#E85D4A]/10 text-[#E85D4A]" : "border-xai-hairline-soft bg-xai-surface-2 text-xai-mute")}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <p className={cn("mt-5 font-mono text-[28px] font-semibold leading-none tracking-[-0.06em] sm:text-[32px]", accent ? "text-[#E85D4A]" : "text-xai-text")}>
        {value.toLocaleString()}
      </p>
      <p className="mt-3 text-[11px] text-xai-mute">{note}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 px-1">
      <span className="size-1.5 rounded-full bg-[#E85D4A]" aria-hidden="true" />
      <p className="xai-eyebrow text-[10px]">{children}</p>
      <span className="h-px flex-1 bg-xai-hairline-soft" aria-hidden="true" />
    </div>
  );
}

function chartOption(
  data: AdminDashboard["daily"],
  fieldA: keyof AdminDashboard["daily"][number],
  fieldB: keyof AdminDashboard["daily"][number],
  labels: [string, string],
  colors: [string, string],
  tokens: ChartTokens
): EChartsOption {
  return {
    animationDuration: 450,
    grid: { left: 8, right: 8, top: 30, bottom: 18, containLabel: true },
    tooltip: { trigger: "axis" },
    legend: { top: 0, right: 0, textStyle: { color: tokens.mute, fontSize: 11 } },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: data.map((item) => item.date.slice(5)),
      axisLabel: { color: tokens.mute, fontSize: 10 },
      axisLine: { lineStyle: { color: tokens.hairlineSoft } },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: tokens.mute, fontSize: 10 },
      splitLine: { lineStyle: { color: tokens.hairlineSoft } },
    },
    series: [
      {
        name: labels[0],
        type: "line",
        smooth: true,
        showSymbol: false,
        data: data.map((item) => item[fieldA]),
        lineStyle: { width: 2, color: colors[0] },
        areaStyle: { color: `${colors[0]}18` },
      },
      {
        name: labels[1],
        type: "line",
        smooth: true,
        showSymbol: false,
        data: data.map((item) => item[fieldB]),
        lineStyle: { width: 2, color: colors[1] },
      },
    ],
  };
}

export default function AdminPage() {
  const t = useTranslations("jobmatch");
  const user = useAuthStore((state) => state.user);
  const [range, setRange] = useState<AdminRange>(7);
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setData(await fetchAdminDashboard(range));
    } catch (error) {
      console.error(error);
      setFailed(true);
      toast.error(t("adminLoadError"));
    } finally {
      setLoading(false);
    }
  }, [range, t]);

  useEffect(() => {
    if (user?.role === "admin") void load();
    else setLoading(false);
  }, [load, user?.role]);

  if (user?.role !== "admin") {
    return (
      <div className="flex h-full items-center justify-center bg-xai-canvas p-6">
        <div className="max-w-sm text-center">
          <ShieldAlert className="mx-auto size-8 text-[#E85D4A]" />
          <p className="mt-4 text-[14px] text-xai-text-mid">{t("adminForbidden")}</p>
        </div>
      </div>
    );
  }

  const traffic = data
    ? data.daily.reduce((totals, item) => ({ pv: totals.pv + item.pv, uv: totals.uv + item.uv }), { pv: 0, uv: 0 })
    : { pv: 0, uv: 0 };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-xai-canvas text-xai-text">
      <header className="flex shrink-0 flex-col gap-4 border-b border-xai-hairline-soft px-4 py-4 sm:px-6 sm:py-5 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#17233C] text-[#FFFDF8] shadow-[4px_4px_0_#E85D4A]"><Activity className="size-4" /></span>
          <div className="min-w-0">
            <p className="xai-eyebrow mb-1 text-[10px]">CONTROL ROOM / 01</p>
            <h1 className="truncate text-[18px] font-semibold tracking-[-0.04em]">{t("adminTitle")}</h1>
            <p className="truncate text-[12px] text-xai-mute">{t("adminSubtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end lg:self-auto">
          <div className="flex rounded-full border border-xai-hairline bg-xai-surface p-1">
            {RANGES.map((item) => (
              <button key={item} type="button" onClick={() => setRange(item)} className={cn("h-7 rounded-full px-3 font-mono text-[11px] transition-colors", item === range ? "bg-xai-text text-xai-canvas" : "text-xai-mute hover:bg-xai-surface-2 hover:text-xai-text")}>{t(`adminRange${item}`)}</button>
            ))}
          </div>
          <button type="button" onClick={() => void load()} className="xai-pill-outline size-9" title={t("adminRefresh")} aria-label={t("adminRefresh")}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-5 sm:px-6 lg:px-8">
        {loading && !data ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-xai-mute"><Loader2 className="size-4 animate-spin" />{t("adminLoading")}</div>
        ) : failed && !data ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[#E85D4A]">{t("adminLoadError")}</div>
        ) : data ? (
          <div className="mx-auto max-w-[1440px] space-y-7">
            <section className="relative overflow-hidden rounded-[24px] bg-[#17233C] px-5 py-5 text-[#FFFDF8] shadow-[6px_6px_0_#E85D4A] sm:px-7 sm:py-6">
              <div className="pointer-events-none absolute -right-10 -top-16 size-48 rounded-full border border-white/10" />
              <div className="pointer-events-none absolute -bottom-24 right-24 size-44 rounded-full border border-white/10" />
              <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="mb-4 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-[#BFC8D8]"><span className="size-1.5 animate-pulse rounded-full bg-[#E85D4A]" />LIVE / ANONYMOUS TRAFFIC</div>
                  <p className="font-mono text-[44px] font-semibold leading-none tracking-[-0.08em] sm:text-[56px]">{traffic.pv.toLocaleString()}</p>
                  <p className="mt-2 text-[12px] text-[#BFC8D8]">{t("adminPV")}</p>
                </div>
                <div className="grid grid-cols-2 gap-6 border-t border-white/15 pt-4 sm:min-w-[280px] sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
                  <div><p className="xai-eyebrow text-[10px] text-[#BFC8D8]">{t("adminUV")}</p><p className="mt-2 font-mono text-[24px] font-semibold tracking-[-0.05em]">{traffic.uv.toLocaleString()}</p></div>
                  <div><p className="xai-eyebrow text-[10px] text-[#BFC8D8]">{t("adminNewUsers")}</p><p className="mt-2 font-mono text-[24px] font-semibold tracking-[-0.05em]">{data.overview.newUsers.toLocaleString()}</p></div>
                </div>
              </div>
            </section>

            <section>
              <SectionLabel>TRAFFIC / USERS</SectionLabel>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard label={t("adminPV")} value={traffic.pv} note={t("adminTrafficTrend")} icon={Activity} accent />
                <MetricCard label={t("adminUV")} value={traffic.uv} note={t("adminSubtitle")} icon={Users} />
                <MetricCard label={t("adminUsers")} value={data.overview.users} note={t("adminNewUsers")} icon={Users} />
                <MetricCard label={t("adminNewUsers")} value={data.overview.newUsers} note={t(`adminRange${range}`)} icon={GitBranch} />
              </div>
            </section>

            <section>
              <SectionLabel>PRODUCT / OUTPUT</SectionLabel>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard label={t("adminResumes")} value={data.overview.masterResumes} note={t("adminResumes")} icon={FileText} />
                <MetricCard label={t("adminMatches")} value={data.overview.derivedResumes} note={t("adminBusinessTrend")} icon={GitBranch} />
                <MetricCard label={t("adminJobs")} value={data.overview.jobs} note={t("adminJobs")} icon={Sparkles} />
                <MetricCard label={t("adminLlmCalls")} value={data.overview.llmCalls} note={`${data.overview.totalTokens.toLocaleString()} ${t("adminTokens")}`} icon={Activity} />
              </div>
            </section>

            <section>
              <SectionLabel>GROWTH / ACTIVATION</SectionLabel>
              <div className="rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium text-xai-text">{t("adminGrowthTitle")}</p>
                    <p className="mt-1 text-[11px] text-xai-mute">{t("adminGrowthSubtitle")}</p>
                  </div>
                  <span className="xai-eyebrow text-[10px]">{t(`adminRange${range}`)}</span>
                </div>
                <div className="space-y-3">
                  {(() => {
                    const funnel = data.growthFunnel ?? {
                      landingView: 0,
                      ctaClick: 0,
                      registerStart: 0,
                      registerSuccess: 0,
                      resumeCreated: 0,
                      firstMatchSuccess: 0,
                      sessionStart: 0,
                    };
                    const stages = [
                      ["landingView", funnel.landingView],
                      ["ctaClick", funnel.ctaClick],
                      ["registerStart", funnel.registerStart],
                      ["registerSuccess", funnel.registerSuccess],
                      ["resumeCreated", funnel.resumeCreated],
                      ["firstMatchSuccess", funnel.firstMatchSuccess],
                    ] as const;
                    return stages.map(([key, value], index) => {
                      const previous = index === 0 ? value : stages[index - 1][1];
                      const rate = index === 0 ? 100 : growthConversionRate(value, previous);
                      return (
                        <div key={key} className="grid gap-2 sm:grid-cols-[150px_1fr_88px] sm:items-center">
                          <p className="text-[12px] text-xai-text-mid">{t(`adminGrowth.${key}`)}</p>
                          <div className="h-2 overflow-hidden rounded-full bg-xai-surface-2" aria-hidden>
                            <div className="h-full rounded-full bg-[#E85D4A] transition-[width]" style={{ width: `${rate}%` }} />
                          </div>
                          <p className="font-mono text-[12px] tabular-nums sm:text-right">{value} <span className="text-xai-mute">/ {rate}%</span></p>
                        </div>
                      );
                    });
                  })()}
                </div>
                <p className="mt-4 text-[11px] leading-relaxed text-xai-mute">{t("adminGrowthPrivacy")}</p>
              </div>
            </section>

            <section>
              <SectionLabel>READOUT / DAILY SIGNAL</SectionLabel>
              <div className="grid gap-4 xl:grid-cols-2">
                <section className="analytics-panel rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3"><div><p className="xai-eyebrow text-[10px]">{t("adminTrafficTrend")}</p><p className="mt-1 text-[12px] text-xai-mute">{t("adminPV")} / {t("adminUV")}</p></div><Activity className="size-4 text-[#E85D4A]" /></div>
                  <div className="mt-4"><EChart revision={`${range}-${traffic.pv}-${traffic.uv}`} height={260} ariaLabel={t("adminTrafficTrend")} build={(tokens) => chartOption(data.daily, "pv", "uv", [t("adminPV"), t("adminUV")], [BRAND_ACCENT, tokens.text], tokens)} /></div>
                </section>
                <section className="analytics-panel rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3"><div><p className="xai-eyebrow text-[10px]">{t("adminBusinessTrend")}</p><p className="mt-1 text-[12px] text-xai-mute">{t("adminNewUsers")} / {t("adminMatches")}</p></div><GitBranch className="size-4 text-[#6D8A78]" /></div>
                  <div className="mt-4"><EChart revision={`${range}-${data.overview.newUsers}-${data.overview.derivedResumes}`} height={260} ariaLabel={t("adminBusinessTrend")} build={(tokens) => chartOption(data.daily, "newUsers", "matches", [t("adminNewUsers"), t("adminMatches")], [tokens.text, "#6D8A78"], tokens)} /></div>
                </section>
              </div>
            </section>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-xai-mute">{t("adminEmpty")}</div>
        )}
      </div>
    </div>
  );
}
