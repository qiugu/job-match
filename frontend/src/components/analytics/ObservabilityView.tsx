import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import {
  getObservability,
  getTraceDetail,
  type AnalyticsDays,
  type Observability,
  type ObservabilityTraceSummary,
  type TraceDetail,
} from "@/lib/jobmatch";
import { formatCount, formatRate } from "@/components/analytics/scale";
import { formatMatchingDuration } from "@/components/analytics/matching-scale";
import { Metric, Panel } from "@/components/analytics/observability-primitives";
import {
  costNodeTotal,
  dailyLabelStep,
  endpointLabel,
  endpointTotal,
  errorTypeDistribution,
  nodeLabel,
  observabilityDailyMax,
  observabilityViewState,
} from "@/components/analytics/observability-scale";
import { cn } from "@/lib/utils";

/** 能力维度子视图（「全部」+ 各端点）。 */
const ENDPOINT_OPTIONS = [
  "",
  "match",
  "cover_letter",
  "ai.translate",
  "ai.polish",
  "ai.grammar",
  "ai.resume_import",
  "jd.image_ocr",
] as const;

function StatusBadge({
  status,
  t,
}: {
  status: string;
  t: (key: string) => string;
}) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-ink">
        <CheckCircle2 className="size-3.5" />
        {t("observabilityStatusSuccess")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
        <XCircle className="size-3.5" />
        {t("observabilityStatusError")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-amber-ink">
      <Loader2 className="size-3.5 animate-spin" />
      {t("observabilityStatusRunning")}
    </span>
  );
}

/** 单次调用的 span 时间线（可展开明细）。 */
function TraceDetailView({
  detail,
  t,
  locale,
}: {
  detail: TraceDetail;
  t: (key: string, values?: Record<string, string | number>) => string;
  locale: string;
}) {
  return (
    <div className="mt-3 border-t border-xai-hairline-soft pt-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <p className="xai-eyebrow text-[9px]">{t("observabilityDetailModel")}</p>
          <p className="mt-1 truncate text-sm">{detail.trace.model || "—"}</p>
        </div>
        <div>
          <p className="xai-eyebrow text-[9px]">{t("observabilityDetailPrompt")}</p>
          <p className="mt-1 font-mono text-sm">{detail.trace.prompt_version || "—"}</p>
        </div>
        <div>
          <p className="xai-eyebrow text-[9px]">{t("observabilityDetailLatency")}</p>
          <p className="mt-1 font-mono text-sm">
            {formatMatchingDuration(detail.trace.latency_ms)}
          </p>
        </div>
        <div>
          <p className="xai-eyebrow text-[9px]">{t("observabilityDetailSpans")}</p>
          <p className="mt-1 font-mono text-sm">{detail.spans.length}</p>
        </div>
      </div>
      {detail.spans.length > 0 && (
        <div className="mt-4 space-y-2">
          {detail.spans.map((span) => (
            <div
              key={span.id}
              className="flex items-center justify-between rounded-lg bg-xai-surface-2 px-3 py-2 text-[12px]"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{nodeLabel(span.step_key, t)}</span>
                {span.attempt > 1 && (
                  <span className="ml-1.5 text-xai-mute">
                    {t("observabilityAttempt")} {span.attempt}
                  </span>
                )}
                {span.error_type && (
                  <span className="ml-1.5 text-destructive">{span.error_type}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-xai-mute">
                {span.total_tokens > 0 && (
                  <span>{formatCount(span.total_tokens, locale)} tok</span>
                )}
                <span>{formatMatchingDuration(span.latency_ms)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {detail.trace.error_type && (
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {detail.trace.error_type}
        </p>
      )}
    </div>
  );
}

export function ObservabilityView({ days }: { days: AnalyticsDays }) {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const [endpoint, setEndpoint] = useState<string>("");
  const [data, setData] = useState<Observability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const detailReq = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    // 切换维度/区间时清空上一轮数据，避免把上一维度的数字短暂显示成当前结果。
    setData(null);
    setSelected(null);
    setDetail(null);
    detailReq.current += 1; // 使在途的 span 详情请求失效
    void getObservability(days, -new Date().getTimezoneOffset(), endpoint || undefined)
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days, endpoint, retryKey]);

  const dailyMax = useMemo(
    () => observabilityDailyMax((data?.daily || []).map((p) => p.total)),
    [data]
  );
  const labelStep = dailyLabelStep(data?.daily?.length ?? 0);
  const epTotal = endpointTotal(data?.endpoints || []);
  const nodeCostTotal = costNodeTotal(data?.cost?.by_node || []);

  const toggleTrace = async (trace: ObservabilityTraceSummary) => {
    if (selected === trace.id) {
      setSelected(null);
      setDetail(null);
      return;
    }
    setSelected(trace.id);
    setDetail(null);
    const req = ++detailReq.current;
    try {
      const result = await getTraceDetail(trace.id);
      if (detailReq.current === req) setDetail(result);
    } catch {
      if (detailReq.current === req) setDetail(null);
    }
  };

  // 能力维度切换条是「常驻骨架」：加载中 / 请求失败 / 空数据都必须保留。
  // 曾经的写法把三个状态做成 early return 直接替换整个视图，导致筛选到无数据
  // 的维度时切换条一起消失，用户被锁死，只能重新挂载页面才能切回「全部」。
  const tabs = (
    <div
      className="flex items-center gap-1 overflow-x-auto rounded-full border border-border bg-card p-1"
      data-testid="observability-endpoint-tabs"
    >
      {ENDPOINT_OPTIONS.map((opt) => (
        <button
          key={opt || "all"}
          type="button"
          aria-pressed={endpoint === opt}
          onClick={() => setEndpoint(opt)}
          className={cn(
            "h-7 shrink-0 rounded-full px-3 text-[11px] transition-colors duration-150",
            endpoint === opt
              ? "bg-xai-text text-xai-canvas"
              : "text-xai-mute hover:bg-xai-surface-2 hover:text-xai-text"
          )}
        >
          {opt ? endpointLabel(opt, t) : t("observabilityEndpointAll")}
        </button>
      ))}
    </div>
  );

  const viewState = observabilityViewState({
    loading,
    error,
    total: data ? data.overview.total : null,
    filtered: Boolean(endpoint),
  });

  if (viewState === "loading") {
    return (
      <div className="space-y-4">
        {tabs}
        <div
          className="flex min-h-[360px] items-center justify-center gap-2 text-[13px] text-xai-mute"
          aria-busy="true"
        >
          <Loader2 className="size-4 animate-spin" />
          {t("observabilityLoading")}
        </div>
      </div>
    );
  }
  if (viewState === "error") {
    return (
      <div className="space-y-4">
        {tabs}
        <div className="flex min-h-[360px] flex-col items-center justify-center gap-3">
          <p className="text-[13px] text-destructive">
            {t("observabilityLoadError")}
          </p>
          <button
            type="button"
            className="xai-pill-primary"
            onClick={() => setRetryKey((k) => k + 1)}
          >
            <RefreshCw className="size-3.5" />
            {t("analyticsRetry")}
          </button>
        </div>
      </div>
    );
  }
  if (viewState === "empty-all" || viewState === "empty-filtered") {
    const filtered = viewState === "empty-filtered";
    return (
      <div className="space-y-4">
        {tabs}
        <div className="flex min-h-[360px] flex-col items-center justify-center gap-2 text-center">
          <p className="text-[14px] font-medium text-xai-text-mid">
            {t(
              filtered
                ? "observabilityEmptyFilteredTitle"
                : "observabilityEmptyTitle"
            )}
          </p>
          <p className="max-w-md text-[13px] leading-relaxed text-xai-mute">
            {t(
              filtered
                ? "observabilityEmptyFilteredDesc"
                : "observabilityEmptyDesc"
            )}
          </p>
          {filtered && (
            <button
              type="button"
              className="xai-pill-primary mt-2"
              onClick={() => setEndpoint("")}
            >
              {t("observabilityBackToAll")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ready 态必有数据；此处仅用于把 data 收窄成非 null，方便下方直接读取。
  if (!data) return null;

  return (
    <div className="space-y-4">
      {tabs}

      {/* KPI 卡：成功率仍是基础，但不再是唯一 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6 lg:gap-4">
        <Metric
          label={t("observabilityKpiCalls")}
          value={formatCount(data.overview.total, locale)}
          hint={`${formatCount(data.overview.success, locale)} ${t("observabilityKpiSuccessSuffix")}`}
        />
        <Metric
          label={t("observabilityKpiSuccessRate")}
          value={formatRate(data.overview.success_rate)}
          hint={t("observabilityKpiSuccessHint")}
        />
        <Metric
          label={t("observabilityKpiAvgLatency")}
          value={formatMatchingDuration(data.overview.avg_latency_ms)}
          hint={`${t("observabilityKpiP95")} ${formatMatchingDuration(data.overview.p95_latency_ms)}`}
        />
        <Metric
          label={t("observabilityKpiNodes")}
          value={formatCount(data.overview.span_count, locale)}
          hint={`${formatCount(data.nodes.length, locale)} ${t("observabilityKpiNodesSuffix")}`}
        />
        <Metric
          label={t("observabilityKpiTokens")}
          value={formatCount(data.overview.total_tokens, locale)}
          hint={t("observabilityKpiTokensHint")}
        />
        <Metric
          label={t("observabilityKpiErrors")}
          value={formatCount(data.overview.error, locale)}
          hint={t("observabilityKpiErrorsHint")}
        />
      </div>

      {/* 每日调用趋势 */}
      <Panel title={t("observabilityChartDaily")}>
        <div className="flex h-40 items-end gap-1.5 border-b border-xai-hairline-soft px-1 pb-1">
          {data.daily.map((point, index) => {
            // 长窗口（如近半年）只抽样显示刻度，但仍保留每个 span 的占位，
            // 否则有刻度/无刻度的列高度不一致，柱子基线会参差不齐。
            const showLabel =
              index % labelStep === 0 || index === data.daily.length - 1;
            return (
              <div
                key={point.date}
                className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                title={`${point.date}: ${point.total}`}
              >
                <div
                  className="w-full max-w-6 rounded-t-sm bg-primary/75 transition-all"
                  style={{ height: `${Math.max(3, (point.total / dailyMax) * 120)}px` }}
                />
                <span
                  className={cn(
                    "invisible whitespace-nowrap text-[9px] text-xai-mute",
                    showLabel && "sm:visible"
                  )}
                >
                  {point.date.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-xai-mute">{t("observabilityChartDailyHint")}</p>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-5">
        {/* 节点执行状态表（核心：可观测性不止成功率） */}
        <div className="xl:col-span-3">
          <Panel title={t("observabilityChartNodes")}>
            <div className="space-y-4">
              {data.nodes.map((node) => {
                const errDist = errorTypeDistribution(node);
                return (
                  <div key={node.step_key}>
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="font-medium">{nodeLabel(node.step_key, t)}</span>
                      <span className="font-mono text-xai-mute">
                        {formatRate(node.success_rate)} ·{" "}
                        {t("observabilityNodeP50")} {formatMatchingDuration(node.p50_latency_ms)} ·{" "}
                        {t("observabilityNodeP95")} {formatMatchingDuration(node.p95_latency_ms)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-xai-surface-2">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${node.success_rate * 100}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-xai-mute">
                      <span>{formatCount(node.calls, locale)} {t("observabilityNodeCalls")}</span>
                      <span>{t("observabilityNodeAvgAttempt")} {node.avg_attempt ?? "—"}</span>
                      <span>{formatCount(node.total_tokens, locale)} tok</span>
                      {errDist.length > 0 && (
                        <span className="text-destructive">
                          {errDist
                            .map((e) => `${e.type}×${e.count}`)
                            .join(" · ")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        {/* 端点/能力维度分布 */}
        <div className="xl:col-span-2">
          <Panel title={t("observabilityChartEndpoints")}>
            <div className="space-y-3">
              {data.endpoints.map((ep) => {
                const percent = epTotal ? ep.calls / epTotal : 0;
                return (
                  <div key={ep.endpoint}>
                    <div className="flex justify-between text-[12px]">
                      <span>{endpointLabel(ep.endpoint, t)}</span>
                      <span className="font-mono text-xai-mute">
                        {ep.calls} · {formatRate(ep.success_rate)} ·{" "}
                        {formatMatchingDuration(ep.avg_latency_ms)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-xai-surface-2">
                      <div
                        className="h-full rounded-full bg-xai-text/75"
                        style={{ width: `${percent * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* 成本与用量归因 */}
          <div className="mt-4">
            <Panel title={t("observabilityChartCost")}>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="font-mono text-[18px] font-semibold text-xai-text">
                    {formatCount(data.cost.total_tokens, locale)}
                  </p>
                  <p className="xai-eyebrow mt-1 text-[9px]">{t("observabilityCostTotal")}</p>
                </div>
                <div>
                  <p className="font-mono text-[18px] font-semibold text-xai-text">
                    {formatCount(data.cost.prompt_tokens, locale)}
                  </p>
                  <p className="xai-eyebrow mt-1 text-[9px]">{t("observabilityCostPrompt")}</p>
                </div>
                <div>
                  <p className="font-mono text-[18px] font-semibold text-xai-text">
                    {formatCount(data.cost.completion_tokens, locale)}
                  </p>
                  <p className="xai-eyebrow mt-1 text-[9px]">{t("observabilityCostCompletion")}</p>
                </div>
              </div>
              {data.cost.by_node.length > 0 && (
                <div className="mt-4 space-y-2">
                  {data.cost.by_node.map((n) => {
                    const percent = nodeCostTotal ? n.total_tokens / nodeCostTotal : 0;
                    return (
                      <div key={n.step_key}>
                        <div className="flex justify-between text-[12px]">
                          <span>{nodeLabel(n.step_key, t)}</span>
                          <span className="font-mono text-xai-mute">
                            {formatCount(n.total_tokens, locale)} · {formatRate(percent)}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-xai-surface-2">
                          <div
                            className="h-full rounded-full bg-amber-ink/70"
                            style={{ width: `${percent * 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>

      {/* 最近调用（可展开 span 时间线） */}
      <Panel title={t("observabilityRecentTraces")}>
        <div className="divide-y divide-xai-hairline-soft">
          {data.recent_traces.map((trace) => (
            <div key={trace.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-xai-surface-2",
                  selected === trace.id && "bg-xai-surface-2"
                )}
                onClick={() => void toggleTrace(trace)}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-xai-text">
                    {endpointLabel(trace.endpoint, t)}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-xai-mute">
                    {trace.started_at?.slice(5, 16).replace("T", " ") || "—"}
                    {trace.model ? ` · ${trace.model}` : ""}
                    {trace.prompt_version ? ` · prompt ${trace.prompt_version}` : ""}
                  </p>
                </div>
                <StatusBadge status={trace.status} t={t} />
                <span className="w-14 text-right font-mono text-[11px] text-xai-mute">
                  {formatMatchingDuration(trace.latency_ms)}
                </span>
                <ChevronRight className="size-4 text-xai-mute" />
              </button>
              {selected === trace.id && detail && (
                <TraceDetailView detail={detail} t={t} locale={locale} />
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export default ObservabilityView;
