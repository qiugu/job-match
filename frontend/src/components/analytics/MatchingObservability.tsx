import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import {
  getMatchObservability,
  getMatchRunDetail,
  type AnalyticsDays,
  type MatchObservability,
  type MatchRunDetail,
  type MatchRunSummary,
} from "@/lib/jobmatch";
import { formatCount, formatRate } from "@/components/analytics/scale";
import {
  formatMatchingDuration,
  matchingDailyMax,
  matchingQualityTotal,
} from "@/components/analytics/matching-scale";
import { cn } from "@/lib/utils";

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="workbench-panel analytics-kpi analytics-panel p-5">
      <p className="xai-eyebrow text-[10px]">{label}</p>
      <p className="mt-2 font-mono text-[28px] font-semibold leading-none tracking-[-0.06em] text-xai-text">
        {value}
      </p>
      {hint && <p className="mt-3 truncate text-[11px] leading-5 text-xai-mute">{hint}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="workbench-panel analytics-panel p-5">
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        <p className="xai-eyebrow text-[10px]">{title}</p>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function stepLabel(key: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    jd_extract: t("matchingStepExtract"),
    resume_match: t("matchingStepMatch"),
    analyze_match: t("matchingStepMatch"),
    keyword_optimize: t("matchingStepOptimize"),
  };
  return labels[key] || key;
}

function RunStatus({ run, t }: { run: MatchRunSummary; t: (key: string) => string }) {
  if (run.status === "success") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600"><CheckCircle2 className="size-3.5" />{t("matchingStatusSuccess")}</span>;
  }
  if (run.status === "error") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-destructive"><XCircle className="size-3.5" />{t("matchingStatusError")}</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[11px] text-amber-600"><Loader2 className="size-3.5 animate-spin" />{t("matchingStatusRunning")}</span>;
}

function Detail({ detail, t }: { detail: MatchRunDetail; t: (key: string) => string }) {
  return (
    <div className="mt-3 border-t border-xai-hairline-soft pt-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><p className="xai-eyebrow text-[9px]">{t("matchingDetailTotalTokens")}</p><p className="mt-1 font-mono text-sm">{formatCount(detail.usage.total_tokens, "zh")}</p></div>
        <div><p className="xai-eyebrow text-[9px]">{t("matchingDetailModel")}</p><p className="mt-1 truncate text-sm">{detail.usage.model || "—"}</p></div>
        <div><p className="xai-eyebrow text-[9px]">{t("matchingDetailMatched")}</p><p className="mt-1 font-mono text-sm">{detail.quality.matched}</p></div>
        <div><p className="xai-eyebrow text-[9px]">{t("matchingDetailMissing")}</p><p className="mt-1 font-mono text-sm">{detail.quality.missing}</p></div>
      </div>
      <div className="mt-4 space-y-2">
        {detail.steps.map((step) => (
          <div key={`${step.step_key}-${step.attempt}`} className="flex items-center justify-between rounded-lg bg-xai-surface-2 px-3 py-2 text-[12px]">
            <span>{stepLabel(step.step_key, t)} · {t("matchingAttempt")} {step.attempt}</span>
            <span className="font-mono text-xai-mute">{formatMatchingDuration(step.latency_ms)}</span>
          </div>
        ))}
      </div>
      {detail.error.message && (
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-destructive"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{detail.error.message}</p>
      )}
    </div>
  );
}

export function MatchingObservability({ days }: { days: AnalyticsDays }) {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const [data, setData] = useState<MatchObservability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchRunDetail | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void getMatchObservability(days, -new Date().getTimezoneOffset())
      .then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days]);

  const dailyMax = useMemo(() => matchingDailyMax((data?.daily || []).map((item) => item.total)), [data]);
  const qualityTotal = data ? matchingQualityTotal(data.quality) : 0;

  const selectRun = async (run: MatchRunSummary) => {
    setSelected(run.id);
    setDetail(null);
    try { setDetail(await getMatchRunDetail(run.id)); } catch { setDetail(null); }
  };

  if (loading && !data) return <div className="flex min-h-[360px] items-center justify-center gap-2 text-[13px] text-xai-mute"><Loader2 className="size-4 animate-spin" />{t("matchingLoading")}</div>;
  if (error && !data) return <div className="flex min-h-[360px] items-center justify-center text-[13px] text-destructive">{t("matchingLoadError")}</div>;
  if (!data || data.overview.total === 0) return <div className="flex min-h-[360px] flex-col items-center justify-center gap-2 text-center"><p className="text-[14px] font-medium text-xai-text-mid">{t("matchingEmptyTitle")}</p><p className="max-w-md text-[13px] leading-relaxed text-xai-mute">{t("matchingEmptyDesc")}</p></div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
        <Metric label={t("matchingKpiRuns")} value={formatCount(data.overview.total, locale)} hint={`${formatCount(data.overview.success, locale)} ${t("matchingKpiSuccessSuffix")}`} />
        <Metric label={t("matchingKpiSuccessRate")} value={formatRate(data.overview.success_rate)} hint={t("matchingKpiSuccessHint")} />
        <Metric label={t("matchingKpiAvgLatency")} value={formatMatchingDuration(data.overview.avg_latency_ms)} hint={`${t("matchingKpiP95")} ${formatMatchingDuration(data.overview.p95_latency_ms)}`} />
        <Metric label={t("matchingKpiAvgScore")} value={data.overview.avg_score == null ? "—" : formatRate(data.overview.avg_score)} hint={t("matchingKpiScoreHint")} />
        <Metric label={t("matchingKpiTokens")} value={formatCount(data.overview.total_tokens, locale)} hint={`${t("matchingKpiApplied")} ${formatRate(data.outcome.applied_rate)}`} />
      </div>

      <Panel title={t("matchingChartDaily")}>
        <div className="flex h-44 items-end gap-1.5 border-b border-xai-hairline-soft px-1 pb-1">
          {data.daily.map((point) => (
            <div key={point.date} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${point.date}: ${point.total}`}>
              <div className="w-full max-w-6 rounded-t-sm bg-primary/75 transition-all" style={{ height: `${Math.max(3, (point.total / dailyMax) * 128)}px` }} />
              <span className="hidden text-[9px] text-xai-mute group-last:inline sm:inline">{point.date.slice(5)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-xai-mute">{t("matchingChartDailyHint")}</p>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3"><Panel title={t("matchingChartSteps")}><div className="space-y-3">{data.steps.map((step) => <div key={step.step_key}><div className="flex items-center justify-between text-[12px]"><span>{stepLabel(step.step_key, t)}</span><span className="font-mono text-xai-mute">{formatRate(step.success_rate)} · {formatMatchingDuration(step.avg_latency_ms)}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-xai-surface-2"><div className="h-full rounded-full bg-primary" style={{ width: `${step.success_rate * 100}%` }} /></div></div>)}</div></Panel></div>
        <div className="xl:col-span-2"><Panel title={t("matchingChartQuality")}><div className="space-y-3">{(["matched", "weak", "missing", "unsupported"] as const).map((key) => { const count = data.quality[key]; const percent = qualityTotal ? count / qualityTotal : 0; return <div key={key}><div className="flex justify-between text-[12px]"><span>{t(`matchingQuality${key[0].toUpperCase()}${key.slice(1)}`)}</span><span className="font-mono text-xai-mute">{count} · {formatRate(percent)}</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-xai-surface-2"><div className="h-full rounded-full bg-xai-text/75" style={{ width: `${percent * 100}%` }} /></div></div>; })}</div><p className="mt-4 text-[11px] leading-5 text-xai-mute">{t("matchingQualityDisclaimer")}</p></Panel></div>
      </div>

      <Panel title={t("matchingRecentRuns")}>
        <div className="divide-y divide-xai-hairline-soft">{data.recent_runs.map((run) => <div key={run.id}><button type="button" className={cn("flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-xai-surface-2", selected === run.id && "bg-xai-surface-2")} onClick={() => void selectRun(run)}><div className="min-w-0 flex-1"><p className="truncate text-[13px] text-xai-text">{run.job_title || t("matchingUntitledJob")}</p><p className="mt-1 truncate text-[11px] text-xai-mute">{run.company || run.started_at || "—"}</p></div><RunStatus run={run} t={t} /><span className="w-14 text-right font-mono text-[11px] text-xai-mute">{run.score == null ? "—" : formatRate(run.score)}</span><span className="w-14 text-right font-mono text-[11px] text-xai-mute">{formatMatchingDuration(run.latency_ms)}</span><ChevronRight className="size-4 text-xai-mute" /></button>{selected === run.id && detail && <Detail detail={detail} t={t} />}</div>)}</div>
      </Panel>
    </div>
  );
}
