// 我的投递（Job Tracking）独立页：以 JD 为中心的机会管理。
// 左侧岗位卡列表（活跃 + 已归档分组），右侧同页详情区。
// 阶段由后端操作驱动（生成话术→待回复、生成定制简历→待投递），
// 本页仅承载两个手动确认：投递成功（applied）/ 失败放弃（closed 归档）与重新开启。
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import { useRouter } from "@/lib/navigation";
import {
  Briefcase,
  Check,
  FileText,
  Loader2,
  Mail,
  RefreshCw,
  Tag,
  Trash2,
  ArchiveRestore,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Translator } from "@/i18n/compat/utils";
import {
  listJobs,
  getJob,
  markJob,
  reopenJob,
  deleteJob,
  type JobSummary,
  type JobDetail,
  type JobStatus,
  type JobCoverLetterBrief,
  type JobDerivedResumeBrief,
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
import { getApplicationStageMeta } from "@/app/app/dashboard/pagePresentation";

// 阶段徽章：中性底 + 中色调圆点（两种主题下均可读，避免 400 系浅色在浅底失效）
const STAGE_DOT: Record<JobStatus, string> = {
  greeting_sent: "#38bdf8",
  resume_ready: "#34d399",
  applied: "#fbbf24",
  closed: "#94a3b8",
};
const STAGE_LABEL: Record<JobStatus, string> = {
  greeting_sent: "jobStatusGreetingSent",
  resume_ready: "jobStatusResumeReady",
  applied: "jobStatusApplied",
  closed: "jobStatusClosed",
};
const ACTIVE_STAGES: JobStatus[] = ["greeting_sent", "resume_ready", "applied"];

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
  matched: "text-emerald-600",
  weak: "text-amber-600",
  missing: "text-rose-500",
  unspported: "text-slate-500",
};
const STRENGTH_PREFIX: Record<string, string> = {
  matched: "✓",
  weak: "~",
  missing: "×",
  unspported: "?",
};

type ConfirmAction = { job: JobSummary; outcome: "applied" | "closed" } | null;
type ConfirmDelete = { job: JobSummary; purge: boolean } | null;

export default function JobsPage() {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const router = useRouter();

  const [rows, setRows] = useState<JobSummary[]>([]);
  const [archived, setArchived] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDelete>(null);
  const selectLock = useRef(false);

  const loadList = useCallback(async () => {
    try {
      const all = await listJobs(true);
      setRows(all.filter((j) => j.status !== "closed"));
      setArchived(all.filter((j) => j.status === "closed"));
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
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [t]
  );

  // 初次进入自动选中第一张活跃卡
  useEffect(() => {
    if (rows.length === 0 || selectLock.current) return;
    selectLock.current = true;
    void selectJob(rows[0].id);
  }, [rows, selectJob]);

  const reloadAfterMutation = useCallback(async () => {
    const all = await listJobs(true);
    setRows(all.filter((j) => j.status !== "closed"));
    setArchived(all.filter((j) => j.status === "closed"));
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
        // 归档的卡重开后仍留在选中态，直接刷新详情
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

  const active = rows;

  return (
    <div className="workbench-page flex h-full min-h-0 flex-col overflow-hidden">
      {/* 顶部：标题 + 新机会入口 */}
      <header className="workbench-header flex shrink-0 flex-col gap-4 border-b px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7 sm:py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-xai-hairline bg-xai-surface text-xai-text">
            <Briefcase className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="xai-eyebrow text-[10px]">APPLICATION DESK</p>
            <h1 className="mt-1 truncate text-[18px] font-medium tracking-[-0.02em] text-xai-text">
              {t("jobsTitle")}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-3 text-[11px] text-xai-mute sm:flex">
            <span><span className="font-mono text-xai-text">{rows.length}</span> active</span>
            <span className="text-xai-hairline-strong">/</span>
            <span><span className="font-mono text-xai-text">{archived.length}</span> archived</span>
          </div>
          <button
            type="button"
            className="xai-pill-primary"
            onClick={() => router.push("/app/dashboard/match")}
          >
            <Tag className="size-3.5" />
            {t("jobPageNewMatch")}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-5 pt-4 sm:px-7 sm:pb-7 lg:flex-row">
        {/* 左：岗位卡列表 */}
        <aside className="flex min-h-[220px] w-full shrink-0 flex-col lg:min-h-0 lg:w-[min(360px,34%)]">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="xai-eyebrow text-[10px]">OPEN OPPORTUNITIES</span>
            <span className="font-mono text-[11px] text-xai-mute">{String(active.length).padStart(2, "0")}</span>
          </div>
          <div className="workbench-panel min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {loading ? (
              <div className="flex items-center gap-2 p-4 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("jobsLoading")}
              </div>
            ) : active.length === 0 && archived.length === 0 ? (
              <div className="p-5 text-center text-[13px] leading-relaxed text-muted-foreground">
                {t("jobsEmpty")}
              </div>
            ) : (
              <>
                {active.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    selected={selectedId === job.id}
                    onSelect={() => void selectJob(job.id)}
                    t={t}
                    locale={locale}
                  />
                ))}
                {archived.length > 0 && (
                  <>
                    <p className="xai-eyebrow px-3 pb-1 pt-3 text-[10px]">
                      {t("jobSectionArchived")}
                    </p>
                    {archived.map((job) => (
                      <JobRow
                        key={job.id}
                        job={job}
                        selected={selectedId === job.id}
                        onSelect={() => void selectJob(job.id)}
                        t={t}
                        locale={locale}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </aside>

        {/* 右：详情区 */}
        <section className="workbench-panel min-h-0 min-w-0 flex-1 overflow-y-auto">
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
        </section>
      </div>

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
                    className={purge ? "bg-rose-600 text-white hover:bg-rose-600/90" : undefined}
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

function JobRow({
  job,
  selected,
  onSelect,
  t,
  locale,
}: {
  job: JobSummary;
  selected: boolean;
  onSelect: () => void;
  t: Translator;
  locale: string;
}) {
  const title = job.title || job.jd_text.split("\n")[0] || t("jobUntitled");
  const dot = STAGE_DOT[job.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg px-3 py-2.5 text-left transition-colors",
        selected
          ? "bg-xai-surface-2 ring-1 ring-xai-hairline"
          : "hover:bg-xai-surface"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex size-3 shrink-0 items-center justify-center">
          <span className="absolute size-2 rounded-full opacity-25" style={{ background: dot }} />
          <span className="relative size-1.5 rounded-full" style={{ background: dot }} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-xai-text">
          {title}
        </span>
        <span className="shrink-0 rounded-full border border-xai-hairline px-1.5 py-px text-[10px] text-xai-mute">
          {t(STAGE_LABEL[job.status])}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-3 pl-3.5 text-[11px] text-xai-mute">
        <span className="inline-flex items-center gap-1">
          <Mail className="size-3" />
          {job.cover_letter_count}
        </span>
        <span className="inline-flex items-center gap-1">
          <RefreshCw className="size-3" />
          {job.derived_count}
        </span>
        <span className="ml-auto">{relTime(job.last_activity_at, locale)}</span>
      </div>
      {job.status !== "closed" && (
        <div className="mt-3 flex items-center gap-1 pl-0.5" aria-hidden="true">
          {ACTIVE_STAGES.map((stage) => {
            const current = getApplicationStageMeta(job.status).index;
            const step = getApplicationStageMeta(stage).index;
            return <span key={stage} className={cn("h-0.5 flex-1 rounded-full", step <= current ? "bg-xai-text" : "bg-xai-hairline")} />;
          })}
        </div>
      )}
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
          className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-rose-400/40 hover:text-rose-400"
          onClick={onDeleteDefault}
        >
          <Trash2 className="size-3" />
          {t("jobDeleteDefault")}
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-rose-400/30 px-3 text-xs text-rose-400 transition-colors hover:bg-rose-500/10"
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
      {ACTIVE_STAGES.map((stage) => {
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
          <span className="shrink-0 rounded-full border border-emerald-500/40 px-1.5 py-px text-[10px] text-emerald-600">
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
                      STRENGTH_TEXT[r.strength] || "text-slate-500"
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
