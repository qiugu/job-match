// 我的投递（Job Tracking）——「控制台 · Calm」样张版式：
// 头部（标题 + 活跃 chip + 搜索 + 新建岗位卡）→ KPI 四卡（黄油 Loud 本周转化）
// → 双栏（左：岗位卡列表；右：本周节奏柱图）。岗位详情移入右侧抽屉（Sheet）。
// 阶段由后端操作驱动（生成话术→待回复、生成定制简历→待投递），
// 仅有的两个手动写入：投递成功（applied）/ 失败放弃（closed 归档）与重新开启。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import { useRouter } from "@/lib/navigation";
import {
  Check,
  FileText,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ArchiveRestore,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Translator } from "@/i18n/compat/utils";
import {
  listJobs,
  getJob,
  getJobStats,
  markJob,
  reopenJob,
  deleteJob,
  type JobSummary,
  type JobDetail,
  type JobStatus,
  type JobCoverLetterBrief,
  type JobDerivedResumeBrief,
  type JobStats,
} from "@/lib/jobmatch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getApplicationStageMeta } from "@/app/app/dashboard/pagePresentation";

// 阶段色（详情抽屉的描边徽章沿用）：色值定义在 globals.css 的 --stage-* 令牌。
const STAGE_DOT: Record<JobStatus, string> = {
  greeting_sent: "var(--stage-greeting)",
  resume_ready: "var(--stage-resume)",
  applied: "var(--stage-applied)",
  closed: "var(--stage-closed)",
};
const STAGE_LABEL: Record<JobStatus, string> = {
  greeting_sent: "jobStatusGreetingSent",
  resume_ready: "jobStatusResumeReady",
  applied: "jobStatusApplied",
  closed: "jobStatusClosed",
};
// 列表卡的短状态 chip：butter=待回复 / mint=待投递 / flat=已投递、已归档（样张 §chip）。
const CHIP_STYLE: Record<JobStatus, { className: string; dot: string; label: string }> = {
  greeting_sent: { className: "border-ink/60 bg-butter", dot: "var(--amber-text)", label: "chipAwaitReply" },
  resume_ready: { className: "border-ink/60 bg-mint", dot: "var(--green)", label: "chipReadyToSend" },
  applied: { className: "border-xai-hairline bg-xai-surface-2", dot: "var(--cobalt)", label: "chipApplied" },
  closed: { className: "border-xai-hairline bg-xai-surface-2", dot: "var(--ink-3)", label: "chipArchived" },
};
// 列表副文：由状态派生（样张「已生成求职话术 / 已生成定制简历 / 已投递 · 等待 HR 反馈 / 岗位已关闭」）。
const SUB_TEXT: Record<JobStatus, string> = {
  greeting_sent: "jobSubGreeting",
  resume_ready: "jobSubResume",
  applied: "jobSubApplied",
  closed: "jobSubClosed",
};

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAY_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function relTime(iso: string | null, loc: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  const isZh = loc.startsWith("zh");
  if (min < 1) return isZh ? "刚刚" : "just now";
  if (min < 60) return isZh ? `${min} 分钟前` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return isZh ? `${hr} 小时前` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return isZh ? `${day} 天前` : `${day}d ago`;
  return new Date(iso).toLocaleDateString(isZh ? "zh-CN" : "en-US");
}

const STRENGTH_TEXT: Record<string, string> = {
  matched: "text-green-ink",
  weak: "text-amber-ink",
  missing: "text-danger",
  unspported: "text-ink-3",
};
const STRENGTH_PREFIX: Record<string, string> = {
  matched: "✓",
  weak: "~",
  missing: "×",
  unspported: "?",
};

type ConfirmAction = { job: JobSummary; outcome: "applied" | "closed" } | null;
type ConfirmDelete = { job: JobSummary; purge: boolean } | null;

/** 本地时区 YYYY-MM-DD（stats daily[].date 同口径，后端已按 tz_offset 归日） */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function JobsPage() {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const router = useRouter();
  const isZh = locale.startsWith("zh");

  const [rows, setRows] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDelete>(null);
  const [stats, setStats] = useState<JobStats | null>(null);

  const loadList = useCallback(async () => {
    try {
      const all = await listJobs(true);
      setRows(all);
    } catch (err) {
      console.error("加载岗位列表失败:", err);
      toast.error(t("jobsLoading"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 本周节奏 / KPI 周增量：近 14 天逐日序列（覆盖本周 + 上周完整对照窗口）
  useEffect(() => {
    getJobStats(14)
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const selectJob = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetailLoading(true);
      try {
        const d = await getJob(id);
        setDetail(d);
      } catch (err) {
        console.error("加载岗位详情失败:", err);
        toast.error(t("jobsLoading"));
        setSelectedId(null);
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [t]
  );

  const reloadAfterMutation = useCallback(async () => {
    const all = await listJobs(true);
    setRows(all);
    if (selectedId) {
      const d = await getJob(selectedId);
      setDetail(d);
    }
  }, [selectedId]);

  const runConfirmAction = async () => {
    if (!confirmAction) return;
    const { job, outcome } = confirmAction;
    setPendingJob(job.id);
    try {
      await markJob(job.id, outcome);
      toast.success(
        outcome === "applied" ? t("jobAppliedToast") : t("jobClosedToast")
      );
      setConfirmAction(null);
      await reloadAfterMutation();
    } catch (err) {
      console.error("更新岗位状态失败:", err);
      toast.error((err as Error).message || t("jobStatusUpdated"));
    } finally {
      setPendingJob(null);
    }
  };

  const runReopen = async (job: JobSummary) => {
    setPendingJob(job.id);
    try {
      await reopenJob(job.id);
      toast.success(t("jobReopenedToast"));
      if (selectedId === job.id) {
        const d = await getJob(job.id);
        setDetail(d);
      }
      await loadList();
    } catch (err) {
      console.error("重新开启岗位失败:", err);
      toast.error((err as Error).message || t("jobStatusUpdated"));
    } finally {
      setPendingJob(null);
    }
  };

  const runDelete = async () => {
    if (!confirmDelete) return;
    const { job, purge } = confirmDelete;
    setPendingJob(job.id);
    try {
      await deleteJob(job.id, purge);
      toast.success(purge ? t("jobPurged") : t("jobDeleted"));
      setConfirmDelete(null);
      if (selectedId === job.id) {
        setSelectedId(null);
        setDetail(null);
      }
      await loadList();
    } catch (err) {
      console.error("删除岗位失败:", err);
      toast.error((err as Error).message || t("jobStatusUpdated"));
    } finally {
      setPendingJob(null);
    }
  };

  const goMatch = (job: JobSummary, run: boolean) => {
    router.push(`/app/dashboard/match?job=${job.id}&mode=match&run=${run ? 1 : 0}`);
  };

  // ---------- 派生数据 ----------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (j) =>
            j.title.toLowerCase().includes(q) ||
            j.company.toLowerCase().includes(q)
        )
      : rows;
    // 按最近活动排序（样张「按最近活动排序」），无活动时间的沉底
    return [...list].sort((a, b) => {
      const ta = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
      const tb = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
      return tb - ta;
    });
  }, [rows, query]);

  const kpi = useMemo(() => {
    const total = rows.length;
    const awaitReply = rows.filter((r) => r.status === "greeting_sent").length;
    const readyToSend = rows.filter((r) => r.status === "resume_ready").length;
    // 本周转化（黄油 Loud）：全程投递转化率 = 历史投递过的卡 / 总卡数（恒 ≤100%）；
    // delta 为本周新增投递（事件数）折算的 pt。newThisWeek 供「累计投递 +N 本周」。
    let newThisWeek: number | null = null;
    let appliedEver: number | null = null;
    let conv: number | null = null;
    let convDelta: number | null = null;
    if (stats && total > 0) {
      appliedEver = stats.totals.applied_ever;
      conv = Math.round((appliedEver / total) * 100);
      const byDate = new Map(stats.daily.map((p) => [p.date, p]));
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      let created = 0;
      let applied = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const p = byDate.get(isoDay(d));
        if (p) {
          created += p.created;
          applied += p.applied;
        }
      }
      newThisWeek = created;
      convDelta = Math.round((applied / total) * 100);
    }
    return { total, awaitReply, readyToSend, newThisWeek, conv, convDelta };
  }, [rows, stats]);

  const rhythm = useMemo(() => {
    if (!stats) return null;
    const byDate = new Map(stats.daily.map((p) => [p.date, p]));
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const applied: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      applied.push(byDate.get(isoDay(d))?.applied ?? 0);
    }
    const lastWeek = [...Array(7)].map((_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() - 7 + i);
      return byDate.get(isoDay(d))?.applied ?? 0;
    });
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const sumCur = sum(applied);
    const sumPrev = sum(lastWeek);
    const maxV = Math.max(...applied, 0);
    const peakIdx = applied.indexOf(Math.max(...applied));
    const wow =
      sumPrev > 0 ? Math.round(((sumCur - sumPrev) / sumPrev) * 100) : null;
    return { applied, sumCur, sumPrev, maxV, peakIdx, wow };
  }, [stats]);

  const detailTitle = detail
    ? `${detail.company ? `${detail.company} · ` : ""}${detail.title || t("jobUntitled")}`
    : t("jobsTitle");

  return (
    <div className="workbench-page flex h-full min-h-0 flex-col overflow-hidden">
      {/* 顶部：标题 + 活跃 chip + 搜索 + 新建岗位卡（样张 wb__top） */}
      <header className="workbench-header flex shrink-0 flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:gap-3.5 sm:px-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-[16px] font-bold tracking-[-0.02em] text-xai-text">
            {t("jobsTitle")}
          </h1>
          <span className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-xai-hairline bg-xai-surface-2 px-2.5 text-[10.5px] font-semibold text-xai-text-mid">
            {t("jobsActiveChip", { n: rows.filter((r) => r.status !== "closed").length })}
          </span>
        </div>
        <div className="flex items-center gap-2.5 sm:ml-auto">
          <label className="hidden h-[34px] w-[190px] items-center gap-2 rounded-full border border-xai-hairline bg-xai-canvas px-3 text-[12.5px] text-xai-mute focus-within:border-xai-hairline-strong md:flex">
            <Search className="size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("jobsSearch")}
              className="w-full bg-transparent text-[12.5px] text-xai-text outline-none placeholder:text-xai-mute"
            />
          </label>
          <button
            type="button"
            className="xai-pill-primary"
            onClick={() => router.push("/app/dashboard/match")}
          >
            <Plus className="size-3.5" />
            {t("jobNewCard")}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-8 pt-5 sm:px-7">
        {/* KPI 四卡（样张 .kpis；黄油 Loud = 本周转化） */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Kpi
            label={t("kpiTotalCards")}
            value={String(kpi.total)}
            delta={kpi.newThisWeek != null && kpi.newThisWeek > 0 ? `+${kpi.newThisWeek} ${t("kpiThisWeekTag")}` : null}
            deltaUp
          />
          <Kpi label={t("kpiAwaitReply")} value={String(kpi.awaitReply)} delta="—" />
          <Kpi label={t("kpiReadyToSend")} value={String(kpi.readyToSend)} delta="—" />
          <Kpi
            hl
            label={t("kpiWeeklyConv")}
            value={kpi.conv != null ? `${kpi.conv}%` : "—"}
            delta={kpi.convDelta != null && kpi.convDelta !== 0 ? `${kpi.convDelta > 0 ? "+" : "−"}${Math.abs(kpi.convDelta)}pt` : null}
            deltaUp={(kpi.convDelta ?? 0) > 0}
          />
        </div>

        <div className="grid items-start gap-4 lg:grid-cols-[1.55fr_1fr]">
          {/* 左：进行中（岗位卡列表，含已归档混排） */}
          <section className="workbench-panel overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-xai-hairline px-4 py-3">
              <b className="text-[13px] font-semibold text-xai-text">{t("sectionOngoing")}</b>
              <span className="eb-zh ml-auto">{t("sortByRecent")}</span>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 p-5 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("jobsLoading")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-5 text-center text-[13px] leading-relaxed text-muted-foreground">
                {rows.length === 0 ? t("jobsEmpty") : t("jobsNoMatch")}
              </div>
            ) : (
              <div>
                {filtered.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    isZh={isZh}
                    onSelect={() => void selectJob(job.id)}
                    t={t}
                  />
                ))}
              </div>
            )}
          </section>

          {/* 右：本周节奏（样张 .bars） */}
          <section className="workbench-panel overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-xai-hairline px-4 py-3">
              <b className="text-[13px] font-semibold text-xai-text">{t("weeklyRhythm")}</b>
              <span className="eb-zh ml-auto">{t("weeklyLegend")}</span>
            </div>
            {rhythm ? (
              <>
                <div className="flex h-[118px] items-end gap-2 px-4 pb-1.5 pt-4">
                  {rhythm.applied.map((v, i) => {
                    const weekend = i >= 5;
                    const dim = weekend || v === 0;
                    const pct = v > 0 && rhythm.maxV > 0 ? Math.max(12, Math.round((v / rhythm.maxV) * 100)) : 0;
                    return (
                      <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                        <i
                          className={cn(
                            "block w-full rounded-t-[3px]",
                            dim ? "bg-xai-surface-2" : "bg-cobalt"
                          )}
                          style={{
                            height: v > 0 ? `${pct}%` : "2px",
                            boxShadow: dim ? undefined : "inset 0 0 0 1.5px var(--ink)",
                          }}
                        />
                        <em className="font-mono text-[9px] not-italic text-xai-mute">
                          {isZh ? WEEKDAY_ZH[i] : WEEKDAY_EN[i]}
                        </em>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between px-4 pb-3.5 pt-1 text-[10.5px] text-xai-mute">
                  <span>
                    {rhythm.sumCur > 0 && rhythm.peakIdx >= 0
                      ? t("rhythmPeak", {
                          day: isZh ? `周${WEEKDAY_ZH[rhythm.peakIdx]}` : WEEKDAY_EN[rhythm.peakIdx],
                          n: rhythm.applied[rhythm.peakIdx],
                        })
                      : "—"}
                  </span>
                  {rhythm.wow != null && rhythm.wow !== 0 ? (
                    <span
                      className={cn(
                        "font-semibold",
                        rhythm.wow > 0 ? "text-green-ink" : "text-danger"
                      )}
                    >
                      {rhythm.wow > 0 ? "↑" : "↓"} {Math.abs(rhythm.wow)}%
                    </span>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-[160px] items-center justify-center text-[12px] text-xai-mute">
                <Loader2 className="mr-2 size-3.5 animate-spin" />
                {t("jobsLoading")}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* 岗位详情抽屉（样张为仪表盘版式，操作流收进 Drawer） */}
      <Sheet open={!!selectedId} onOpenChange={(o) => !o && setSelectedId(null)}>
        <SheetContent
          side="right"
          className="theme-xai flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[560px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{detailTitle}</SheetTitle>
          </SheetHeader>
          {detailLoading || !detail ? (
            <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-muted-foreground">
              {detailLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {t("jobsLoading")}
                </span>
              ) : (
                t("jobDetailEmpty")
              )}
            </div>
          ) : (
            <JobDetailView
              detail={detail}
              pending={pendingJob === detail.id}
              onGenerate={() => goMatch(detail, true)}
              onConfirmApplied={() => setConfirmAction({ job: detail, outcome: "applied" })}
              onConfirmClosed={() => setConfirmAction({ job: detail, outcome: "closed" })}
              onReopen={() => void runReopen(detail)}
              onDeleteDefault={() => setConfirmDelete({ job: detail, purge: false })}
              onPurge={() => setConfirmDelete({ job: detail, purge: true })}
              t={t}
              locale={locale}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* 手动确认：投递成功 / 失败放弃 */}
      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(o) => !o && setConfirmAction(null)}
      >
        <AlertDialogContent>
          {(() => {
            const c = confirmAction;
            if (!c) return null;
            const applied = c.outcome === "applied";
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {applied ? t("jobConfirmAppliedTitle") : t("jobCloseConfirmTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {applied ? t("jobConfirmAppliedDesc") : t("jobCloseConfirmDesc")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setConfirmAction(null)}>
                    {t("cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction onClick={() => void runConfirmAction()}>
                    {applied ? t("jobConfirmAppliedBtn") : t("jobCloseBtn")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除两档确认 */}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          {(() => {
            const c = confirmDelete;
            if (!c) return null;
            const { job, purge } = c;
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {purge ? t("jobPurgeConfirmTitle") : t("jobDeleteDefault")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {purge
                      ? t("jobPurgeConfirmDesc", {
                          cl: job.cover_letter_count,
                          dr: job.derived_count,
                        })
                      : t("jobDeleteDefaultHint", {
                          cl: job.cover_letter_count,
                          dr: job.derived_count,
                        })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setConfirmDelete(null)}>
                    {t("cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void runDelete()}
                    className={purge ? "bg-danger text-white hover:opacity-90" : undefined}
                  >
                    {purge ? t("jobPurgeConfirmBtn") : t("jobDeleteDefault")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** KPI 卡（样张 .kpi；hl = 黄油 Loud 本周转化） */
function Kpi({
  label,
  value,
  delta,
  deltaUp = false,
  hl = false,
}: {
  label: string;
  value: string;
  delta?: string | null;
  deltaUp?: boolean;
  hl?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3.5 transition-colors",
        hl
          ? "border-ink bg-butter"
          : "border-xai-hairline bg-xai-surface hover:border-xai-hairline-strong"
      )}
    >
      <p className="eb-zh">{label}</p>
      <div className="mt-1.5 flex items-baseline gap-2">
        <b className="text-[26px] font-bold leading-none tracking-[-0.03em] tabular-nums text-xai-text">
          {value}
        </b>
        {delta ? (
          <span
            className={cn(
              "text-[10.5px] font-semibold tabular-nums",
              deltaUp ? "text-green-ink" : "text-xai-mute"
            )}
          >
            {delta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 岗位卡行（样张 .job：公司·职位 + 状态副文 + 状态 chip + 相对时间） */
function JobRow({
  job,
  isZh,
  onSelect,
  t,
}: {
  job: JobSummary;
  isZh: boolean;
  onSelect: () => void;
  t: Translator;
}) {
  const chip = CHIP_STYLE[job.status];
  const title = [job.company, job.title || job.jd_text.split("\n")[0] || t("jobUntitled")]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onSelect}
      className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-b border-xai-hairline-soft px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-xai-surface sm:grid-cols-[1fr_96px_74px]"
    >
      <div className="min-w-0">
        <b className="block truncate text-[13.5px] font-semibold text-xai-text">
          {title}
        </b>
        <span className="mt-0.5 block truncate text-[11.5px] text-xai-mute">
          {t(SUB_TEXT[job.status])}
        </span>
      </div>
      <span
        className={cn(
          "hidden h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-semibold text-xai-text sm:inline-flex",
          chip.className
        )}
      >
        <i
          className="size-[7px] shrink-0 rounded-full"
          style={{ background: chip.dot }}
        />
        {t(chip.label)}
      </span>
      <span className="text-right font-mono text-[10.5px] tabular-nums text-xai-mute">
        {relTime(job.last_activity_at, isZh ? "zh" : "en")}
      </span>
    </button>
  );
}

function JobDetailView({
  detail,
  pending,
  onGenerate,
  onConfirmApplied,
  onConfirmClosed,
  onReopen,
  onDeleteDefault,
  onPurge,
  t,
  locale,
}: {
  detail: JobDetail;
  pending: boolean;
  onGenerate: () => void;
  onConfirmApplied: () => void;
  onConfirmClosed: () => void;
  onReopen: () => void;
  onDeleteDefault: () => void;
  onPurge: () => void;
  t: Translator;
  locale: string;
}) {
  const isClosed = detail.status === "closed";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 卡头：标题 + 阶段 + 阶段化 CTA */}
      <div className="shrink-0 border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[17px] font-medium text-xai-text">
                {detail.title || t("jobUntitled")}
              </h2>
              <span
                className="shrink-0 rounded-full border border-xai-hairline px-2 py-0.5 text-[11px] text-xai-text-mid"
                style={{
                  boxShadow: `inset 2px 0 0 ${STAGE_DOT[detail.status]}`,
                }}
              >
                {t(STAGE_LABEL[detail.status])}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-xai-mute">
              {detail.company ? (
                <>
                  {detail.company} · {relTime(detail.updated_at, locale)}
                </>
              ) : (
                relTime(detail.updated_at, locale)
              )}
            </p>
            <StageRail status={detail.status} t={t} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isClosed ? (
              <button
                type="button"
                disabled={pending}
                onClick={onReopen}
                className="xai-pill-outline disabled:opacity-50"
              >
                <ArchiveRestore className="size-3.5" />
                {t("jobReopenBtn")}
              </button>
            ) : (
              <>
                {detail.status === "greeting_sent" && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onGenerate}
                    className="xai-pill-primary disabled:opacity-50"
                  >
                    <Mail className="size-3.5" />
                    {t("jobGenerateResume")}
                  </button>
                )}
                {detail.status === "resume_ready" && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onConfirmApplied}
                    className="xai-pill-primary disabled:opacity-50"
                  >
                    <Check className="size-3.5" />
                    {t("jobConfirmAppliedBtn")}
                  </button>
                )}
                {detail.status === "resume_ready" && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onGenerate}
                    className="xai-pill-outline disabled:opacity-50"
                  >
                    <RefreshCw className="size-3.5" />
                    {t("jobGenerateResume")}
                  </button>
                )}
                {!detail.status.startsWith("applied") && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onConfirmClosed}
                    className="xai-pill-outline disabled:opacity-50"
                  >
                    {t("jobMarkClosed")}
                  </button>
                )}
                {detail.status === "applied" && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={onConfirmClosed}
                    className="xai-pill-outline disabled:opacity-50"
                  >
                    {t("jobCloseBtn")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* 详情体：岗位描述（全文）+ 定制简历（含匹配分析回看）+ 话术记录 */}
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-6 sm:px-7">
        {/* 岗位描述：JD 是整条投递的上下文锚点，全文直接展示在正文区随页面滚动，不做折叠 */}
        <section>
          <h3 className="xai-eyebrow mb-3 text-[10px]">{t("jobDetailJd")}</h3>
          <div className="whitespace-pre-wrap break-words rounded-xl border border-xai-hairline-soft bg-xai-canvas/70 px-4 py-4 text-[12.5px] leading-[1.8] text-xai-text-mid">
            {detail.jd_text || t("jobDetailJd")}
          </div>
        </section>

        {/* 定制简历与匹配结果 */}
        <section>
          <h3 className="xai-eyebrow mb-3 text-[10px]">{t("jobDetailResumes")}</h3>
          {detail.derived_resumes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-xai-hairline p-4 text-[12px] text-xai-mute">
              {isClosed ? t("jobNoDerived") : t("jobPitchCtaDesc")}
            </div>
          ) : (
            <div className="space-y-3">
              {detail.derived_resumes.map((dr) => (
                <DerivedCard key={dr.id} dr={dr} t={t} />
              ))}
            </div>
          )}
        </section>

        {/* 话术记录 */}
        <section>
          <h3 className="xai-eyebrow mb-3 text-[10px]">{t("jobDetailPitches")}</h3>
          {detail.cover_letters.length === 0 ? (
            <div className="rounded-xl border border-dashed border-xai-hairline p-4 text-[12px] text-xai-mute">
              {t("jobNoPitch")}
            </div>
          ) : (
            <div className="space-y-3">
              {detail.cover_letters.map((cl) => (
                <PitchCard key={cl.id} cl={cl} t={t} />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 危险操作 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-xai-hairline-soft px-5 py-3 sm:px-7">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-danger hover:text-danger"
          onClick={onDeleteDefault}
        >
          <Trash2 className="size-3" />
          {t("jobDeleteDefault")}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-danger px-3 text-xs text-danger transition-colors hover:bg-blush"
          onClick={onPurge}
        >
          <Trash2 className="size-3" />
          {t("jobPurge")}
        </button>
      </div>
    </div>
  );
}

function StageRail({
  status,
  t,
}: {
  status: JobStatus;
  t: Translator;
}) {
  const current = getApplicationStageMeta(status).index;

  if (status === "closed") {
    return (
      <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-xai-hairline px-3 py-1.5 text-[11px] text-xai-mute">
        <span className="size-1.5 rounded-full bg-xai-mute" />
        {t("jobStatusClosed")}
      </div>
    );
  }

  return (
    <div className="mt-5 grid max-w-xl grid-cols-3 gap-2" aria-label="Application progress">
      {(["greeting_sent", "resume_ready", "applied"] as JobStatus[]).map((stage) => {
        const meta = getApplicationStageMeta(stage);
        const complete = meta.index <= current;
        return (
          <div key={stage} className="space-y-2">
            <div className={cn("h-1 rounded-full", complete ? "bg-xai-text" : "bg-xai-hairline")} />
            <span className={cn("block text-[10px] leading-tight", complete ? "text-xai-text-mid" : "text-xai-eyebrow")}>
              {t(meta.label)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DerivedCard({
  dr,
  t,
}: {
  dr: JobDerivedResumeBrief;
  t: Translator;
}) {
  const a = dr.analysis;
  const pct = a?.score != null ? Math.round(Math.min(1, Math.max(0, a.score)) * 100) : null;
  return (
    <div className="rounded-xl border border-xai-hairline-soft bg-xai-canvas/30 p-4">
      <div className="flex items-center gap-2">
        <FileText className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {dr.title}
        </span>
        {dr.accepted && (
          <span className="shrink-0 rounded-full border border-green px-1.5 py-px text-[10px] text-green-ink">
            {t("jobAcceptedTag")}
          </span>
        )}
      </div>

      {a ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="font-mono text-[15px] font-medium text-foreground">
                {pct}
              </span>
              %
            </span>
            <span>{t("jobScore")}</span>
            {a.role && <span className="text-muted-foreground">· {a.role}</span>}
          </div>
          {a.summary && (
            <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">
              {a.summary}
            </p>
          )}
          {a.requirements && a.requirements.length > 0 && (
            <ul className="space-y-1.5 border-t border-border pt-2">
              {a.requirements.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px]">
                  <span
                    className={cn(
                      "mt-px font-mono",
                      STRENGTH_TEXT[r.strength] || "text-ink-3"
                    )}
                  >
                    {STRENGTH_PREFIX[r.strength] || "·"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">{r.requirement}</span>
                    {r.evidence && (
                      <span className="ml-1.5 text-muted-foreground">— {r.evidence}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("jobNoAnalysisHint")}
        </p>
      )}

      {dr.markdown_content && (
        <details className="group mt-3 border-t border-border pt-2">
          <summary className="cursor-pointer select-none text-[12px] text-muted-foreground transition-colors hover:text-foreground">
            {t("jobFullResume")}
          </summary>
          <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-sans text-[12px] leading-relaxed text-foreground">
            {dr.markdown_content}
          </pre>
        </details>
      )}
    </div>
  );
}

function PitchCard({
  cl,
  t,
}: {
  cl: JobCoverLetterBrief;
  t: Translator;
}) {
  return (
    <div className="rounded-xl border border-xai-hairline-soft bg-xai-canvas/30 p-4">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Mail className="size-3" />
        <span className="rounded border border-border px-1 py-px uppercase">{cl.scene}</span>
        <span className="ml-auto">{relTime(cl.created_at, "zh")}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
        {cl.content}
      </p>
    </div>
  );
}
