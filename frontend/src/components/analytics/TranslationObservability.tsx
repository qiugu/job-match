import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import {
  getTranslationCallDetail,
  getTranslationObservability,
  type AiCallSummary,
  type AnalyticsDays,
  type TranslationCallDetail,
  type TranslationObservability as TranslationObservabilityData,
} from "@/lib/jobmatch";
import { formatCount, formatRate } from "@/components/analytics/scale";
import { formatMatchingDuration } from "@/components/analytics/matching-scale";
import { Metric, Panel } from "@/components/analytics/MatchingObservability";
import {
  translationCallSummaryText,
  translationDailyMax,
  translationGroupTotal,
} from "@/components/analytics/translation-scale";
import { cn } from "@/lib/utils";

/**
 * AI 翻译可观测面板（analytics 页 `ai` tab）。
 *
 * 存在的理由：翻译的可观测性此前只有一行台账汇总 + 一条滚动日志，「12 个字段里
 * 哪个没译、哪一类字段整组没译、当时用的是哪版翻译指令」全靠猜。这里把台账读成
 * 三块可读信号：KPI、未变化分组分布、可展开的单次明细。
 *
 * 视觉与交互刻意复用 `MatchingObservability`（同一页的两个 tab 不能长成两套语言）：
 * 同样的 Metric/Panel 原语、同样「列表行点击就地展开」的交互，不引入抽屉或弹窗。
 */
function StatusBadge({ call, t }: { call: AiCallSummary; t: (key: string) => string }) {
  if (call.status === "success") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-ink">
        <CheckCircle2 className="size-3.5" />
        {t("translationStatusSuccess")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
      <XCircle className="size-3.5" />
      {t("translationStatusError")}
    </span>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="xai-eyebrow text-[9px]">{label}</p>
      <p className="mt-1 truncate font-mono text-sm">{value}</p>
    </div>
  );
}

function CallDetail({
  detail,
  t,
  locale,
}: {
  detail: TranslationCallDetail;
  t: (key: string, values?: Record<string, string | number>) => string;
  locale: string;
}) {
  const summary = detail.call.summary;
  return (
    <div className="mt-3 border-t border-xai-hairline-soft pt-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCell
          label={t("translationDetailTokens")}
          value={formatCount(detail.call.total_tokens, locale)}
        />
        <MetricCell
          label={t("translationDetailModel")}
          value={detail.call.model || "—"}
        />
        <MetricCell
          label={t("translationDetailLatency")}
          value={formatMatchingDuration(detail.call.latency_ms)}
        />
        <MetricCell
          label={t("translationDetailPrompt")}
          value={detail.call.prompt_version || "—"}
        />
      </div>

      {summary && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCell
            label={t("translationDetailFieldsTotal")}
            value={formatCount(summary.fields_total, locale)}
          />
          <MetricCell
            label={t("translationDetailFieldsTranslated")}
            value={formatCount(summary.fields_translated, locale)}
          />
          <MetricCell
            label={t("translationDetailFieldsUnchanged")}
            value={formatCount(summary.fields_unchanged, locale)}
          />
          <MetricCell
            label={t("translationDetailFieldsMissing")}
            value={formatCount(summary.fields_missing, locale)}
          />
        </div>
      )}

      {detail.unchanged_keys.length > 0 && (
        <div className="mt-4">
          <p className="xai-eyebrow text-[9px]">
            {t("translationDetailUnchangedKeys")}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {detail.unchanged_keys.map((key) => (
              <code
                key={key}
                className="rounded bg-xai-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-xai-text-mid"
              >
                {key}
              </code>
            ))}
          </div>
          {detail.unchanged_keys_truncated > 0 && (
            <p className="mt-2 text-[11px] text-xai-mute">
              {t("translationDetailMoreKeys", {
                count: detail.unchanged_keys_truncated,
              })}
            </p>
          )}
        </div>
      )}

      {!detail.call.detail_available && (
        <p className="mt-3 text-[11px] leading-5 text-xai-mute">
          {t("translationNoDetailHint")}
        </p>
      )}

      {detail.call.error_type && (
        <p className="mt-3 text-[11px] leading-5 text-destructive">
          {detail.call.error_type}
        </p>
      )}
    </div>
  );
}

export function TranslationObservability({ days }: { days: AnalyticsDays }) {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const [data, setData] = useState<TranslationObservabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TranslationCallDetail | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setSelected(null);
    setDetail(null);
    void getTranslationObservability(days, -new Date().getTimezoneOffset())
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
  }, [days]);

  const dailyMax = translationDailyMax(
    (data?.daily || []).map((point) => point.total)
  );
  const groupTotal = translationGroupTotal(data?.unchanged_groups || []);

  const toggleCall = async (call: AiCallSummary) => {
    if (selected === call.id) {
      setSelected(null);
      setDetail(null);
      return;
    }
    setSelected(call.id);
    setDetail(null);
    try {
      setDetail(await getTranslationCallDetail(call.id));
    } catch {
      setDetail(null);
    }
  };

  /** 分组名来自字段路径，缺翻译时回退原始前缀（比显示 key 本身可读）。 */
  const groupLabel = (group: string) => {
    const key = `translationGroups.${group}`;
    const label = t(key);
    return label === key ? group : label;
  };

  if (loading && !data) {
    return (
      <div className="flex min-h-[360px] items-center justify-center gap-2 text-[13px] text-xai-mute">
        <Loader2 className="size-4 animate-spin" />
        {t("translationLoading")}
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="flex min-h-[360px] items-center justify-center text-[13px] text-destructive">
        {t("translationLoadError")}
      </div>
    );
  }
  if (!data || data.overview.total === 0) {
    return (
      <div className="flex min-h-[360px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-[14px] font-medium text-xai-text-mid">
          {t("translationEmptyTitle")}
        </p>
        <p className="max-w-md text-[13px] leading-relaxed text-xai-mute">
          {t("translationEmptyDesc")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
        <Metric
          label={t("translationKpiCalls")}
          value={formatCount(data.overview.total, locale)}
          hint={`${formatCount(data.overview.success, locale)} ${t("translationKpiSuccessSuffix")}`}
        />
        <Metric
          label={t("translationKpiSuccessRate")}
          value={formatRate(data.overview.success_rate)}
          hint={t("translationKpiSuccessHint")}
        />
        <Metric
          label={t("translationKpiLatency")}
          value={formatMatchingDuration(data.overview.avg_latency_ms)}
          hint={`${t("translationKpiP95")} ${formatMatchingDuration(data.overview.p95_latency_ms)}`}
        />
        <Metric
          label={t("translationKpiUnchanged")}
          value={formatRate(data.overview.unchanged_rate)}
          hint={`${formatCount(data.overview.fields_unchanged, locale)} / ${formatCount(
            data.overview.fields_translated + data.overview.fields_unchanged,
            locale
          )} ${t("translationKpiUnchangedSuffix")}`}
        />
        <Metric
          label={t("translationKpiTokens")}
          value={formatCount(data.overview.total_tokens, locale)}
          hint={`${t("translationKpiAvgFields")} ${data.overview.avg_fields_per_call ?? "—"}`}
        />
      </div>

      <Panel title={t("translationChartDaily")}>
        <div className="flex h-44 items-end gap-1.5 border-b border-xai-hairline-soft px-1 pb-1">
          {data.daily.map((point) => (
            <div
              key={point.date}
              className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${point.date}: ${point.total}`}
            >
              <div
                className="w-full max-w-6 rounded-t-sm bg-primary/75 transition-all"
                style={{
                  height: `${Math.max(3, (point.total / dailyMax) * 128)}px`,
                }}
              />
              <span className="hidden text-[9px] text-xai-mute group-last:inline sm:inline">
                {point.date.slice(5)}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-xai-mute">
          {t("translationChartDailyHint")}
        </p>
      </Panel>

      <Panel title={t("translationChartGroups")}>
        {data.unchanged_groups.length === 0 ? (
          <p className="text-[12px] text-xai-mute">
            {t("translationChartGroupsEmpty")}
          </p>
        ) : (
          <div className="space-y-3">
            {data.unchanged_groups.map((item) => {
              const percent = groupTotal ? item.count / groupTotal : 0;
              return (
                <div key={item.group}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span>{groupLabel(item.group)}</span>
                    <span className="font-mono text-xai-mute">
                      {item.count} · {formatRate(percent)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-xai-surface-2">
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
        <p className="mt-4 text-[11px] leading-5 text-xai-mute">
          {t("translationChartGroupsHint")}
        </p>
      </Panel>

      <Panel title={t("translationRecentCalls")}>
        <div className="divide-y divide-xai-hairline-soft">
          {data.recent_calls.map((call) => (
            <div key={call.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-xai-surface-2",
                  selected === call.id && "bg-xai-surface-2"
                )}
                onClick={() => void toggleCall(call)}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-xai-text">
                    {translationCallSummaryText(call.summary, t)}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-xai-mute">
                    {call.created_at?.slice(5, 16).replace("T", " ") || "—"}
                    {call.summary?.target_lang
                      ? ` · ${call.summary.target_lang}`
                      : ""}
                    {call.prompt_version ? ` · prompt ${call.prompt_version}` : ""}
                  </p>
                </div>
                <StatusBadge call={call} t={t} />
                <span className="w-14 text-right font-mono text-[11px] text-xai-mute">
                  {formatMatchingDuration(call.latency_ms)}
                </span>
                <ChevronRight className="size-4 text-xai-mute" />
              </button>
              {selected === call.id && detail && (
                <CallDetail detail={detail} t={t} locale={locale} />
              )}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export default TranslationObservability;
