import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import {
  getAdminAiObservability,
  type AdminAiObservability,
  type AiCallSummary,
} from "@/lib/jobmatch";
import { formatCount, formatRate } from "@/components/analytics/scale";
import { formatMatchingDuration } from "@/components/analytics/matching-scale";
import { cn } from "@/lib/utils";

/**
 * 管理员视角的 AI 观测段（admin 页第五段）。
 *
 * 与用户侧 analytics 的「翻译可观测性」tab 是**同一份台账的两个视角**：
 * 那边只看自己的翻译字段明细，这边看全站各端点的调用量、失败与最近活动。
 * 之所以仍要管理视角：成本与失败率是跨用户的，单用户页面永远看不出
 * 「某个端点最近全在失败」。
 *
 * user_id 只显示后 6 位：够定位到人，又不把完整标识摊在管理页上。
 *
 * 注意：`SectionLabel` 在此处就地定义，而不是从 admin/page 导入——page 会
 * import 本组件，反向导入会形成循环依赖。
 */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 px-1">
      <span className="size-1.5 rounded-full bg-cobalt" aria-hidden="true" />
      <p className="xai-eyebrow text-[10px]">{children}</p>
      <span className="h-px flex-1 bg-xai-hairline-soft" aria-hidden="true" />
    </div>
  );
}
function StatCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
      <p className="xai-eyebrow text-[10px]">{label}</p>
      <p className="mt-5 font-mono text-[26px] font-semibold leading-none tracking-[-0.06em] text-xai-text">
        {value}
      </p>
      {note && <p className="mt-3 truncate text-[11px] text-xai-mute">{note}</p>}
    </div>
  );
}

function CallRow({ call, locale }: { call: AiCallSummary; locale: string }) {
  const failed = call.status !== "success";
  return (
    <div className="flex items-center gap-3 py-2.5 text-[12px]">
      <span className="w-[86px] shrink-0 font-mono text-[11px] text-xai-mute">
        {call.created_at?.slice(5, 16).replace("T", " ") || "—"}
      </span>
      <span className="w-[108px] shrink-0 truncate font-mono text-[11px]">
        {call.endpoint || "—"}
      </span>
      <span
        className={cn(
          "w-[64px] shrink-0 text-[11px]",
          failed ? "text-destructive" : "text-green-ink"
        )}
      >
        {failed ? call.error_type || "error" : "ok"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-xai-mute">
        {call.summary
          ? `${call.summary.fields_total} → ${call.summary.fields_translated} / ${call.summary.fields_unchanged}`
          : "—"}
      </span>
      <span className="w-[64px] shrink-0 text-right font-mono text-[11px] text-xai-mute">
        {formatCount(call.total_tokens, locale)}
      </span>
      <span className="w-[56px] shrink-0 text-right font-mono text-[11px] text-xai-mute">
        {formatMatchingDuration(call.latency_ms)}
      </span>
      <span className="w-[64px] shrink-0 text-right font-mono text-[10px] text-xai-mute">
        {call.user_id ? `…${call.user_id.slice(-6)}` : "—"}
      </span>
    </div>
  );
}

export function AdminAiSection({ days }: { days: number }) {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const [data, setData] = useState<AdminAiObservability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void getAdminAiObservability(days, -new Date().getTimezoneOffset())
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

  const successRate = data
    ? data.overview.total > 0
      ? data.overview.success / data.overview.total
      : 0
    : 0;
  const maxCalls = Math.max(1, ...(data?.endpoints || []).map((row) => row.calls));

  return (
    <div>
      <SectionLabel>{t("adminAiSection")}</SectionLabel>

      {loading && !data && (
        <div className="flex h-32 items-center justify-center gap-2 text-[13px] text-xai-mute">
          <Loader2 className="size-4 animate-spin" />
          {t("translationLoading")}
        </div>
      )}

      {error && !data && (
        <p className="flex items-center gap-2 text-[12px] text-destructive">
          <AlertTriangle className="size-4" />
          {t("adminAiLoadError")}
        </p>
      )}

      {data && data.overview.total === 0 && (
        <p className="text-[12px] text-xai-mute">{t("adminAiEmpty")}</p>
      )}

      {data && data.overview.total > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <StatCard
              label={t("adminAiCalls")}
              value={formatCount(data.overview.total, locale)}
              note={`${formatCount(data.overview.success, locale)} ${t("translationKpiSuccessSuffix")}`}
            />
            <StatCard
              label={t("translationKpiSuccessRate")}
              value={formatRate(successRate)}
              note={`${formatCount(data.overview.error, locale)} ${t("adminAiErrorsSuffix")}`}
            />
            <StatCard
              label={t("translationKpiTokens")}
              value={formatCount(data.overview.total_tokens, locale)}
            />
            <StatCard
              label={t("adminAiEndpoints")}
              value={formatCount(data.overview.endpoints, locale)}
            />
          </div>

          <div className="rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
            <p className="xai-eyebrow text-[10px]">{t("adminAiByEndpoint")}</p>
            <div className="mt-4 space-y-3">
              {data.endpoints.map((row) => (
                <div key={row.endpoint}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="font-mono text-[11px]">{row.endpoint}</span>
                    <span className="font-mono text-[11px] text-xai-mute">
                      {row.calls} · {formatRate(row.success_rate)} ·{" "}
                      {formatMatchingDuration(row.avg_latency_ms)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-xai-surface-2">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(row.calls / maxCalls) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
            <p className="xai-eyebrow text-[10px]">{t("adminAiFailures")}</p>
            {data.failures.length === 0 ? (
              <p className="mt-3 text-[12px] text-xai-mute">
                {t("adminAiNoFailures")}
              </p>
            ) : (
              <div className="mt-3 divide-y divide-xai-hairline-soft">
                {data.failures.map((call) => (
                  <CallRow key={call.id} call={call} locale={locale} />
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-xai-hairline-soft bg-xai-surface p-4 sm:p-5">
            <p className="xai-eyebrow text-[10px]">{t("adminAiRecent")}</p>
            <div className="mt-3 divide-y divide-xai-hairline-soft">
              {data.recent_calls.map((call) => (
                <CallRow key={call.id} call={call} locale={locale} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminAiSection;
