import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import { useAuthStore } from "@/store/useAuthStore";
import { motion } from "framer-motion";
import {
  Target,
  FileText,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowRight,
  Tag,
  Check,
  RefreshCw,
  Mail,
  Crosshair,
  Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import ResumeDiffView from "@/components/match/ResumeDiffView";
import CoverLetterPanel from "@/components/match/CoverLetterPanel";
import { useResumeStore } from "@/store/useResumeStore";
import { useRouter } from "@/lib/navigation";
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
import {
  listMasterResumes,
  createMatch,
  acceptMatch,
  createCoverLetter,
  detectJob,
  listJobs,
  getJob,
  type CreateMatchPayload,
  type MasterResumeSummary,
  type MatchResult,
  type CoverLetterScene,
  type JobSummary,
} from "@/lib/jobmatch";
import TaskModePicker, { type TaskMode } from "@/components/match/TaskModePicker";

// 把毫秒格式化为「秒.十分位」，如 1.2s / 12.3s；超过 60s 显示 m:ss
function formatElapsed(ms: number): string {
  if (ms < 1000) return "0.0s";
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 相对时间（中英文自适应），用于 detect 重复确认里「何时打过招呼」的展示。 */
function relTime(iso: string | null, loc: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const day = Math.floor((Date.now() - then) / 86400000);
  const isZh = loc.startsWith("zh");
  if (day <= 0) return isZh ? "今天" : "today";
  if (day === 1) return isZh ? "昨天" : "yesterday";
  if (day < 30) return isZh ? `${day} 天前` : `${day}d ago`;
  return new Date(iso).toLocaleDateString(isZh ? "zh-CN" : "en-US");
}

/** 匹配得分环形图（xAI 风格：hairline 轨道 + 单色弧线 + 中心大数字） */
function ScoreRing({ pct, size = 132 }: { pct: number; size?: number }) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = c * (1 - clamped / 100);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          style={{ stroke: "var(--xai-hairline)" }}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
          style={{ stroke: "var(--xai-success)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[28px] leading-none text-xai-text">
          {clamped}%
        </span>
      </div>
    </div>
  );
}

/** 匹配基准简历：用户已上传的简历（markdown 文本） */
type ResumeSource = {
  kind: "master";
  id: string;
  title: string;
  rawText: string;
  /** 原简历的层级 Markdown 骨架（确定性提取，作为匹配结构锚点；可能为空） */
  markdownContent: string | null;
};

/**
 * 匹配基准正文：优先用原简历的层级 Markdown 骨架（保留标题/列表/加粗等结构，
 * LLM 才可能「结构不动、只改内容」）；骨架缺失时退回 PDF 纯文本。
 */
function matchBaseText(src: ResumeSource): string {
  return src.markdownContent && src.markdownContent.trim()
    ? src.markdownContent
    : src.rawText;
}

/**
 * 剥离 LLM 在简历正文前附加的说明性前言（形如「已根据 JD 优化…」+ `---` 分隔线）。
 * 后端 prompt 已要求只输出简历正文，但历史数据与偶发输出仍可能带前言，
 * 这里做防御性清理：整篇被代码块围栏包裹时先去围栏，再从第一个一级标题开始截取正文。
 */
function stripMarkdownPreamble(md: string): string {
  if (!md) return md;
  let text = md.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  const lines = text.split(/\r?\n/);
  const h1Index = lines.findIndex((line) => /^#\s+\S/.test(line));
  // h1Index <= 0 说明没有前言或整篇就是标题起头，保持原样
  if (h1Index <= 0) return text;

  // 标题前的内容：只剥离「纯说明性前言」（非对齐容器、非简历版式声明）。
  // 居中等版式用 :::xxx 容器表达，必须保留——否则预览与 PDF 导出会丢失对齐。
  const preamble = lines.slice(0, h1Index);
  const hasAlignContainer = preamble.some((line) =>
    /^\s*:::(left|center|right)\b/i.test(line)
  );
  if (hasAlignContainer) {
    // 存在对齐容器声明：整体保留，不让 strip 误伤版式
    return text;
  }
  return lines.slice(h1Index).join("\n").trim();
}

/** 品牌强调紫（与侧边栏 primary 一致的 accent，用于环形靶签名元素） */
const BRAND_VIOLET = "271 72% 47%"; /* xAI accent-dusk #7C3AED */

export default function JobMatchPage() {
  const t = useTranslations("jobmatch");
  const locale = useLocale();
  const router = useRouter();
  const { syncResumeToBackend } = useResumeStore();
  // 左侧「匹配配置 / JD」抽屉：默认打开；收起后结果区占满剩余宽度
  const [drawerOpen, setDrawerOpen] = useState(true);

  const [masters, setMasters] = useState<MasterResumeSummary[]>([]);
  const [selected, setSelected] = useState<ResumeSource | null>(null);
  const [jdText, setJdText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  // 任务类型：默认「打招呼话术」（轻操作，先建立机会），重操作（定制简历）留给有正反馈的岗位。
  // 三者是平级入口——话术不再需要先跑完匹配才能进入。
  const [taskMode, setTaskMode] = useState<TaskMode>("pitch");
  // 仅话术模式下在配置区选场景（匹配模式下场景在结果区的话术面板里选）
  const [pitchScene, setPitchScene] = useState<CoverLetterScene>("greeting");
  // 仅话术模式产出的独立话术 id（不关联任何匹配结果）
  const STORAGE_KEY_LAST_PITCH = "jdmatch.lastCoverLetterId";
  const [soloPitchId, setSoloPitchId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_LAST_PITCH);
    } catch {
      return null;
    }
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [accepted, setAccepted] = useState<boolean>(false);
  const [accepting, setAccepting] = useState<boolean>(false);
  // 接受后询问「是否立刻编辑简历」的弹窗；pendingMasterId 为落库的 master resume id
  const [editNowOpen, setEditNowOpen] = useState<boolean>(false);
  const [pendingMasterId, setPendingMasterId] = useState<string | null>(null);
  // 结果区当前 tab：匹配分析（默认） / 简历 / 话术
  const [resultTab, setResultTab] = useState<"resume" | "analysis" | "pitch">(
    "analysis"
  );
  // 「优化简历」内部子视图：A4 预览（用于 PDF 导出） / 左右对比（高亮修改 + hover 依据）
  const [resumeView, setResumeView] = useState<"preview" | "compare">("compare");
  // 最近一次匹配的衍生简历 id：写入 localStorage，使得刷新页面后话术面板仍能按此 id
  // 从 DB 加载历史话术（验收：话术为独立 DB 资源，刷新后不丢失）。
  const STORAGE_KEY_LAST_DERIVED = "jdmatch.lastDerivedResumeId";
  const [lastDerivedResumeId, setLastDerivedResumeId] = useState<string | null>(
    () => {
      try {
        return localStorage.getItem(STORAGE_KEY_LAST_DERIVED);
      } catch {
        return null;
      }
    }
  );

  // 岗位卡（Job Tracking）：当前上下文 jobId 与 detect 重复确认。
  // 岗位列表/详情已独立为左侧导航页 /app/dashboard/jobs，此处不再维护抽屉。
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [detectConfirm, setDetectConfirm] = useState<{
    jd: string;
    job: JobSummary;
  } | null>(null);

  const formCardRef = useRef<HTMLDivElement>(null);
  const resultCardRef = useRef<HTMLDivElement>(null);

  // 结果区是否处于「仅话术」视图：独立产出的话术，没有也不需要有匹配结果。
  // 与 taskMode 分开——用户可在出结果后切回任务类型，不应丢失已产出的话术。
  const pitchOnlyView = !result && Boolean(soloPitchId);

  const loadMasters = async () => {
    try {
      const summaries = await listMasterResumes();
      setMasters(summaries);
    } catch (err) {
      console.error("Failed to load uploaded PDF resumes:", err);
      toast.error(t("loadMastersError"));
    }
  };

  // 每次进入「优化简历」匹配页（路由激活）都重新同步内存中未落库简历到后端，
  // 并刷新下拉列表。用 pathname 驱动而非仅 mount，避免路由缓存导致不重跑。
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (pathname !== "/app/dashboard/match") return;
    (async () => {
      const { resumes: current, syncedIds: synced } = useResumeStore.getState();
      const unsynced = Object.keys(current).filter(
        (id) => !synced.has(id)
      );
      await Promise.all(
        unsynced.map((id) =>
          syncResumeToBackend(id).catch((err) =>
            console.error("同步历史简历失败:", id, err)
          )
        )
      );
      await loadMasters();
    })();
  }, [pathname]);

  // 默认选择：第一份已上传简历
  useEffect(() => {
    if (selected) return;
    if (masters.length > 0) {
      setSelected({
        kind: "master",
        id: masters[0].id,
        title: masters[0].title,
        rawText: masters[0].rawText,
        markdownContent: masters[0].markdownContent,
      });
    }
  }, [masters, selected]);

  // 新结果生成时，默认回到「匹配分析」tab
  useEffect(() => {
    if (result) setResultTab("analysis");
  }, [result?.id]);

  const handleGoToResumes = () => {
    router.push("/app/dashboard/resumes");
  };

  // 计时器启停：开始任务时启动，结束（成功/失败）时清理
  const startTimer = () => {
    setElapsedMs(0);
    const startedAt = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
  };
  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 生成一次话术（不跑匹配）。返回新话术 id，失败返回 null。 */
  const generatePitch = async (
    baseText: string,
    scene: CoverLetterScene,
    derivedResumeId?: string,
    jdOverride?: string
  ): Promise<string | null> => {
    try {
      const letter = await createCoverLetter({
        resume_text: baseText,
        jd_text: jdOverride ?? jdText,
        scene,
        derived_resume_id: derivedResumeId,
      });
      // 写链路自动挂载岗位卡：把返回的 job_id 记入当前上下文
      if (typeof letter.job_id === "string") setCurrentJobId(letter.job_id);
      if (typeof letter.remaining_credits === "number") {
        useAuthStore.getState().applyCredits(letter.remaining_credits);
      }
      return letter.id;
    } catch (err) {
      console.error("生成话术失败:", err);
      const status = (err as Error & { status?: number }).status;
      toast.error(
        status === 403 ? (err as Error).message : t("pitchGenerateError")
      );
      return null;
    }
  };

  /** 仅话术模式：跳过简历优化链路，直接生成话术（约 2 秒，不产出匹配结果）。 */
  const handlePitchOnly = async (baseText: string, jdOverride?: string) => {
    setLoading(true);
    setSoloPitchId(null);
    startTimer();
    try {
      const id = await generatePitch(baseText, pitchScene, undefined, jdOverride);
      if (id) {
        setSoloPitchId(id);
        try {
          localStorage.setItem(STORAGE_KEY_LAST_PITCH, id);
        } catch {
          /* 忽略 localStorage 不可用的情况 */
        }
        toast.success(t("pitchGenerated"));
      }
    } finally {
      stopTimer();
      setLoading(false);
    }
  };

  const handleCreate = async (jdOverride?: string, modeOverride?: TaskMode) => {
    const mode = modeOverride ?? taskMode;
    const effJd = jdOverride ?? jdText;
    if (!selected) {
      toast.warning(t("selectResumeFirst"));
      return;
    }
    const baseText = matchBaseText(selected);
    if (!baseText.trim()) {
      toast.warning(t("emptyResumeText"));
      return;
    }
    if (!effJd.trim()) return;

    // 仅话术：不触发匹配，直接生成（话术与匹配是平级入口）
    if (mode === "pitch") {
      await handlePitchOnly(baseText, effJd);
      return;
    }

    setLoading(true);
    setResult(null);
    setSoloPitchId(null);
    startTimer();
    try {
      const payload: CreateMatchPayload = {
        resumeText: baseText,
        jdText: effJd,
        title: selected.title,
      };
      const data = await createMatch(payload);
      setResult(data);
      setAccepted(Boolean(data.accepted));
      // 写链路自动挂载岗位卡：把返回的 jobId 记入当前上下文
      if (typeof data.jobId === "string") setCurrentJobId(data.jobId);
      // 记录最近匹配 id：供话术面板刷新后从 DB 加载历史话术
      if (data.id) {
        setLastDerivedResumeId(data.id);
        try {
          localStorage.setItem(STORAGE_KEY_LAST_DERIVED, data.id);
        } catch {
          /* 忽略 localStorage 不可用的情况 */
        }
      }
      // 匹配会扣积分：用后端返回的剩余积分刷新侧边栏显示
      if (typeof data.remainingCredits === "number") {
        useAuthStore.getState().applyCredits(data.remainingCredits);
      }
      // 「两者都要」：匹配完成后按当前场景接着生成话术（话术约 2 秒，
      // 失败不回滚已产出的匹配结果，仅提示）。
      if (mode === "both" && data.id) {
        await generatePitch(baseText, pitchScene, data.id, effJd);
      }
    } catch (err) {
      console.error("Match failed:", err);
      // 403=积分不足：直接展示后端提示，其余错误走通用文案
      const status = (err as Error & { status?: number }).status;
      toast.error(status === 403 ? (err as Error).message : t("matchError"));
    } finally {
      stopTimer();
      setLoading(false);
    }
  };

  // 恢复岗位 JD 上下文到工作台（岗位列表 → 点击卡片）
  const handleRestoreJob = (job: JobSummary) => {
    setJdText(job.jd_text);
    setCurrentJobId(job.id);
    toast.success(t("jobRestoredHint"));
  };

  // JD 文本域失焦：按归一化 JD 查重，命中且非当前上下文则弹确认（仅提示不拦截）
  const handleDetectDuplicate = async () => {
    const jd = jdText.trim();
    if (!jd) return;
    try {
      const res = await detectJob(jd);
      if (res.job_id && res.job_id !== currentJobId) {
        const all = await listJobs();
        const job = all.find((j) => j.id === res.job_id);
        if (job) setDetectConfirm({ jd, job });
      }
    } catch {
      /* 查重失败不打扰用户 */
    }
  };

  // 仅话术结果区的「生成定制简历」衔接：切到匹配任务，用同一 JD 立即发起匹配。
  const handleGenerateResumeFromPitch = () => {
    setTaskMode("match");
    handleCreate(jdText, "match");
  };

  // 从「我的投递」页跳转携带的意图：?job=<id>&mode=match&run=1 时，
  // 自动把该岗位 JD 回填到工作台并立即以「定制简历」发起匹配（岗位页生成/重新匹配）。
  const [pendingJobRun, setPendingJobRun] = useState<string | null>(null);
  const jobIntentRef = useRef(false);
  useEffect(() => {
    if (pathname !== "/app/dashboard/match" || jobIntentRef.current) return;
    jobIntentRef.current = true;
    try {
      const params = new URLSearchParams(window.location.search);
      const jobId = params.get("job");
      if (!jobId) return;
      (async () => {
        const d = await getJob(jobId);
        setJdText(d.jd_text);
        setCurrentJobId(d.id);
        const mode = params.get("mode");
        if (mode === "match" || mode === "both") setTaskMode(mode);
        if (params.get("run") === "1") setPendingJobRun(d.jd_text);
      })().catch((err) => console.error("恢复岗位上下文失败:", err));
    } catch {
      /* window 不可用的环境忽略 */
    }
  }, [pathname]);

  // run=1：待基准简历就绪（selected 就位）后立即发起一次「定制简历」匹配
  useEffect(() => {
    if (!pendingJobRun || !selected) return;
    const jd = pendingJobRun;
    setPendingJobRun(null);
    void handleCreate(jd, "match");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJobRun, selected]);

  // 「接受」= 把匹配结果采纳并落库为「我的简历」中的一份资产（后端按 markdown 去重复用）。
  // 落库成功后弹窗询问是否立刻打开编辑器微调，用户也可选择稍后。
  const handleAccept = async () => {
    if (!result) return;
    setAccepting(true);
    try {
      const res = await acceptMatch(result.id, true);
      setAccepted(res.accepted);
      toast.success(t("acceptSavedToMyResume"));
      // 去重置位时 masterResumeId 已是已有记录，同样支持打开编辑器
      setPendingMasterId(res.masterResumeId);
      setEditNowOpen(true);
    } catch (err) {
      console.error("Accept failed:", err);
      toast.error(t("acceptError"));
    } finally {
      setAccepting(false);
    }
  };

  // 立刻编辑：跳转到该简历的编辑器工作台
  const handleEditNow = () => {
    if (!pendingMasterId) return;
    setEditNowOpen(false);
    router.push(`/app/workbench/${pendingMasterId}`);
  };

  // 稍后再说：仅落库，留在匹配页
  const handleEditLater = () => {
    setEditNowOpen(false);
    setPendingMasterId(null);
  };

  // 回到匹配配置（已无主简历溯源，仅滚动定位）
  const handleTraceSource = () => {
    if (!result) return;
    formCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const sourceToValue = (s: ResumeSource) => `${s.kind}:${s.id}`;

  const sourceFromValue = (value: string): ResumeSource | null => {
    const sep = value.indexOf(":");
    if (sep < 0) return null;
    const id = value.slice(sep + 1);
    const master = masters.find((m) => m.id === id);
    return master
      ? {
          kind: "master",
          id,
          title: master.title,
          rawText: master.rawText,
          markdownContent: master.markdownContent,
        }
      : null;
  };

  const hasAnyResume = masters.length > 0;
  const hasAnalysis = !!result?.matchAnalysis;

  return (
    <div className="h-full w-full">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex h-full w-full flex-col px-4 py-6 sm:px-6"
      >
        {/* 页头：标题 + 环形靶签名装饰 */}
        <div className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {/* 环形靶：唯一的签名元素 */}
            <div
              className="relative flex h-14 w-14 shrink-0 items-center justify-center"
              aria-hidden
            >
              <span
                className="absolute inset-0 rounded-full border"
                style={{ borderColor: `hsl(${BRAND_VIOLET} / 0.35)` }}
              />
              <span
                className="absolute inset-[7px] rounded-full border"
                style={{ borderColor: `hsl(${BRAND_VIOLET} / 0.55)` }}
              />
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full"
                style={{ backgroundColor: `hsl(${BRAND_VIOLET} / 0.12)` }}
              >
                <Crosshair
                  className="h-4.5 w-4.5"
                  style={{ color: `hsl(${BRAND_VIOLET})` }}
                />
              </span>
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">
                {t("title")}
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {t("subtitle")}
              </p>
            </div>
          </div>
        </div>

        {/* 工作台：左侧配置为「真正可滑入/滑出的抽屉」，结果区始终占据主区域。
            抽屉用 translateX 横向推拉（不重排布局），结果区用 lg:ml-[400px] 让出
            空间并平滑过渡——打开时结果占剩余宽度，关闭时占满，绝不会变成上下结构。
            不设固定高度：结果区自适应内容高度，避免底部无谓留白。 */}
        <div className="relative flex h-full w-full min-h-0 flex-1 overflow-hidden">
          {/* 左栏：匹配配置抽屉（深炭黑输入面板）。
              统一用 absolute + 外层 overflow-hidden 裁剪：
              收起时 translate-x 移出视口并被裁剪，不会穿透侧边栏。 */}
          <aside
            ref={formCardRef}
            className={cn(
              "absolute inset-y-0 left-0 z-20 flex w-[min(400px,88vw)] flex-col overflow-hidden rounded-r-xl border border-border bg-card text-card-foreground shadow-lg transition-transform duration-300 ease-out",
              drawerOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            {/* 面板头部：等宽 eyebrow + 标题 */}
            <div className="relative overflow-hidden px-5 pb-2 pt-5">
              <p className="xai-eyebrow">01 · MATCH CONFIG</p>
              <h2 className="mt-1.5 text-sm font-semibold tracking-wide">
                {t("createMatch")}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("createMatchDesc")}
              </p>
            </div>

            <ScrollArea className="flex-1">
              <div className="space-y-6 px-5 py-4">
                {/* 任务类型：JD 简历匹配 / JD 话术匹配 / 两者都要（平级入口） */}
                <TaskModePicker
                  value={taskMode}
                  onChange={setTaskMode}
                  disabled={loading}
                />

                {/* 选择要优化的简历 */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t("masterResume")}
                  </Label>
                  {hasAnyResume ? (
                    <div className="flex items-center gap-2">
                      <Select
                        value={selected ? sourceToValue(selected) : undefined}
                        onValueChange={(v) => {
                          const next = sourceFromValue(v);
                          if (next) setSelected(next);
                        }}
                      >
                        <SelectTrigger className="w-full border-border bg-muted/40 text-card-foreground data-[state=open]:border-primary">
                          <SelectValue placeholder={t("selectMaster")} />
                        </SelectTrigger>
                        <SelectContent>
                          {masters.map((m) => (
                            <SelectItem key={`master:${m.id}`} value={`master:${m.id}`}>
                              <span className="flex items-center gap-2">
                                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate">{m.title}</span>
                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  {m.source === "pdf" ? t("sourcePdf") : t("sourceEditor")}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                      <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
                      <p className="mx-auto mt-3 max-w-[260px] text-sm text-muted-foreground">
                        {t("noMaster")}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4 border-border bg-transparent text-card-foreground hover:bg-muted/60"
                        onClick={handleGoToResumes}
                      >
                        {t("goToMyResumes")}
                        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{t("masterResumeDesc")}</p>
                </div>

                {/* 岗位描述 */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t("jd")}
                  </Label>
                  <Textarea
                    value={jdText}
                    onChange={(e) => setJdText(e.target.value)}
                    onBlur={handleDetectDuplicate}
                    placeholder={t("jdPlaceholder")}
                    disabled={loading}
                    className="min-h-[160px] resize-y border-border bg-muted/40 text-card-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary/20"
                  />
                </div>

                {/* 话术场景：只要任务涉及话术就出现（仅话术 / 两者都要） */}
                {taskMode !== "match" && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {t("pitchScene")}
                    </Label>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          ["greeting", "pitchGreeting"],
                          ["followup", "pitchFollowup"],
                          ["interview", "pitchInterview"],
                        ] as Array<[CoverLetterScene, string]>
                      ).map(([val, key]) => (
                        <button
                          key={val}
                          type="button"
                          disabled={loading}
                          onClick={() => setPitchScene(val)}
                          className={cn(
                            "rounded-lg border px-2 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                            pitchScene === val
                              ? "border-primary bg-primary/[0.06] text-foreground"
                              : "border-border bg-muted/30 text-muted-foreground hover:border-primary/40"
                          )}
                        >
                          {t(key)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 开始匹配 */}
                <button
                  type="button"
                  onClick={() => handleCreate()}
                  disabled={loading || !selected}
                  className="group flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground font-semibold transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : taskMode === "pitch" ? (
                    <Mail className="h-4 w-4" />
                  ) : (
                    <Crosshair className="h-4 w-4 transition-transform group-hover:rotate-90" />
                  )}
                  {loading
                    ? taskMode === "pitch"
                      ? t("generatingPitch")
                      : t("matching")
                    : taskMode === "pitch"
                      ? t("startPitch")
                      : taskMode === "both"
                        ? t("startBoth")
                        : t("startMatch")}
                </button>

              </div>
            </ScrollArea>
          </aside>

          {/* 右栏：匹配结果 —— 白纸台面。
              大屏下通过 lg:ml-[400px] 让出抽屉空间并平滑过渡（push 模式）；
              抽屉收起时 lg:ml-0，结果占满，绝不变上下结构。小屏抽屉为 overlay，结果始终全宽。 */}
          <section
            ref={resultCardRef}
            className={cn(
              "relative flex w-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[margin] duration-300 ease-out h-full",
              drawerOpen ? "lg:ml-[400px]" : "lg:ml-0"
            )}
          >
            {/* 结果区头部（sticky） */}
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setDrawerOpen((v) => !v)}
                  title={drawerOpen ? "收起匹配配置" : "打开匹配配置"}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
                >
                  {drawerOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeftOpen className="h-4 w-4" />
                  )}
                </button>
                {/* 我的投递：跳转到独立的投递管理页（列表 + 详情 + 阶段化 CTA） */}
                <button
                  type="button"
                  onClick={() => router.push("/app/dashboard/jobs")}
                  title={t("jobsToggle")}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Briefcase className="h-4 w-4" />
                </button>
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `hsl(${BRAND_VIOLET} / 0.12)` }}
                >
                  {pitchOnlyView ? (
                    <Mail className="h-4.5 w-4.5" style={{ color: `hsl(${BRAND_VIOLET})` }} />
                  ) : (
                    <Target className="h-4.5 w-4.5" style={{ color: `hsl(${BRAND_VIOLET})` }} />
                  )}
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">
                    {pitchOnlyView ? t("pitchResult") : t("result")}
                  </h2>
                  <p className="truncate text-xs text-muted-foreground">
                    {result
                      ? result.title
                      : pitchOnlyView
                        ? t("pitchResultDesc")
                        : t("resultEmpty")}
                  </p>
                </div>
              </div>

            </header>

            {/* 结果区 body：滚动区 + sticky 底部 */}
            {loading ? (
              <div className="flex-1 space-y-4 px-6 py-5">
                <div
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  style={{
                    borderColor: `hsl(${BRAND_VIOLET} / 0.25)`,
                    backgroundColor: `hsl(${BRAND_VIOLET} / 0.06)`,
                    color: `hsl(${BRAND_VIOLET})`,
                  }}
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  {taskMode === "pitch"
                    ? t("generatingPitchDesc")
                    : t("matchingDesc")}
                  <span className="ml-auto tabular-nums font-medium">
                    {formatElapsed(elapsedMs)}
                  </span>
                </div>
                {taskMode === "pitch" ? (
                  // 仅话术：约 2 秒出结果，骨架按话术形态给（一段正文 + 操作条）
                  <div className="space-y-3 rounded-lg border border-border p-4">
                    <Skeleton className="h-5 w-20" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-11/12" />
                    <Skeleton className="h-4 w-4/5" />
                  </div>
                ) : (
                  <div className="space-y-3 rounded-lg border border-border p-4">
                    <Skeleton className="h-5 w-24" />
                    <div className="flex flex-wrap gap-2">
                      <Skeleton className="h-6 w-16 rounded-full" />
                      <Skeleton className="h-6 w-24 rounded-full" />
                      <Skeleton className="h-6 w-20 rounded-full" />
                    </div>
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                )}
              </div>
            ) : pitchOnlyView ? (
              // 仅话术结果：直接呈现话术，不套匹配结果的 Tab 结构
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                {/* 仅话术模式的结果衔接：对方要简历了 → 用同一 JD 生成定制简历 */}
                <div className="mb-4 rounded-[10px] border border-border bg-card p-4">
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `hsl(${BRAND_VIOLET} / 0.12)` }}
                    >
                      <Crosshair
                        className="h-4 w-4"
                        style={{ color: `hsl(${BRAND_VIOLET})` }}
                      />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground">
                        {t("jobPitchCtaTitle")}
                      </p>
                      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                        {t("jobPitchCtaDesc")}
                      </p>
                      <button
                        type="button"
                        className="xai-pill-primary mt-3"
                        onClick={handleGenerateResumeFromPitch}
                        disabled={!selected || loading}
                      >
                        <Crosshair className="h-3.5 w-3.5" />
                        {t("jobPitchCtaBtn")}
                      </button>
                    </div>
                  </div>
                </div>
                <CoverLetterPanel
                  resumeText={selected ? matchBaseText(selected) : ""}
                  jdText={jdText}
                  focusId={soloPitchId ?? undefined}
                />
              </div>
            ) : !result ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-10">
                  <div
                    className="pointer-events-none absolute left-1/2 top-1/2 h-[360px] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full border"
                    style={{ borderColor: `hsl(${BRAND_VIOLET} / 0.1)` }}
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute left-1/2 top-1/2 h-[240px] w-[240px] -translate-x-1/2 -translate-y-1/2 rounded-full border"
                    style={{ borderColor: `hsl(${BRAND_VIOLET} / 0.14)` }}
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute left-1/2 top-1/2 h-[120px] w-[120px] -translate-x-1/2 -translate-y-1/2 rounded-full border"
                    style={{ borderColor: `hsl(${BRAND_VIOLET} / 0.2)` }}
                    aria-hidden
                  />
                  <div className="relative flex flex-col items-center text-center">
                    <div
                      className="flex h-14 w-14 items-center justify-center rounded-full"
                      style={{ backgroundColor: `hsl(${BRAND_VIOLET} / 0.1)` }}
                    >
                      <Crosshair className="h-7 w-7" style={{ color: `hsl(${BRAND_VIOLET})` }} />
                    </div>
                    <h3 className="mt-5 text-base font-semibold">{t("resultEmpty")}</h3>
                    <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                      {t("resultHint")}
                    </p>
                  </div>
                </div>
                {/* 刷新后：若最近匹配过，仍从 DB 加载历史话术（话术为独立资源，不随匹配结果丢失）。
                    若用户从「我的投递」恢复了某张卡，则按 job_id 过滤展示该卡的话术。 */}
                {(lastDerivedResumeId || currentJobId) && (
                  <div className="shrink-0 overflow-y-auto border-t border-border px-6 py-5">
                    <CoverLetterPanel
                      resumeText={selected ? matchBaseText(selected) : ""}
                      jdText={jdText}
                      derivedResumeId={currentJobId ? undefined : lastDerivedResumeId ?? undefined}
                      jobId={currentJobId ?? undefined}
                    />
                  </div>
                )}
              </div>
            ) : (
              <Tabs
                value={resultTab}
                onValueChange={(v) => setResultTab(v as typeof resultTab)}
                className="flex min-h-0 flex-1 flex-col"
              >
                {/* Tab 切换条：匹配分析（默认） / 优化简历 */}
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 pt-3">
                  <TabsList className="h-10 rounded-full bg-muted/50 p-1">
                    {hasAnalysis && (
                      <TabsTrigger
                        value="analysis"
                        className="h-8 rounded-full px-4 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                      >
                        <Target className="mr-1.5 h-3.5 w-3.5" />
                        {t("matchAnalysis")}
                      </TabsTrigger>
                    )}
                    <TabsTrigger
                      value="resume"
                      className="h-8 rounded-full px-4 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      <FileText className="mr-1.5 h-3.5 w-3.5" />
                      {t("optimizedResume")}
                    </TabsTrigger>
                    {/* 话术 tab 仅在「两者都要」时出现：选了「仅 JD 匹配」就不该看到话术入口 */}
                    {taskMode === "both" && (
                      <TabsTrigger
                        value="pitch"
                        className="h-8 rounded-full px-4 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                      >
                        <Mail className="mr-1.5 h-3.5 w-3.5" />
                        {t("matchAnalysisCoverLetter")}
                      </TabsTrigger>
                    )}
                  </TabsList>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                  <div className="px-6 py-5">
                    {/* 结果摘要条：得分 / 关键词命中 / 逐条统计 + 主操作（两个 tab 共用） */}
                    {(() => {
                      const a = result.matchAnalysis;
                      const scorePct =
                        typeof a?.score === "number" ? Math.round(a.score * 100) : null;
                      const reqs = a?.requirements ?? [];
                      const met = reqs.filter((r) => r.strength === "matched").length;
                      const weak = reqs.filter((r) => r.strength === "weak").length;
                      const missing = reqs.filter((r) => r.strength === "missing").length;
                      const optimizedText = stripMarkdownPreamble(result.markdownContent);
                      const kwTotal = result.keywords?.length ?? 0;
                      const kwHit = kwTotal
                        ? result.keywords.filter((k) =>
                            optimizedText.toLowerCase().includes(String(k).toLowerCase())
                          ).length
                        : 0;
                      return (
                        <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-4 rounded-[10px] border border-border bg-card px-6 py-4">
                          <div className="shrink-0">
                            <div className="font-mono text-[24px] leading-none text-xai-text">
                              {scorePct ?? "—"}
                              {scorePct !== null && <span className="text-sm">%</span>}
                            </div>
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              综合匹配得分
                            </div>
                          </div>
                          <div className="h-9 w-px shrink-0 bg-border" />
                          <div className="shrink-0">
                            <div className="font-mono text-[24px] leading-none text-xai-add">
                              {kwHit}/{kwTotal}
                            </div>
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              关键词命中
                            </div>
                          </div>
                          <div className="h-9 w-px shrink-0 bg-border" />
                          <div className="shrink-0">
                            <div className="text-[20px] font-medium leading-none text-xai-text">
                              {reqs.length} 项
                            </div>
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              满足 {met} · 部分 {weak} · 缺失 {missing}
                            </div>
                          </div>
                          <div className="ml-auto flex flex-wrap items-center gap-2.5">
                            {accepted ? (
                              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-500">
                                <Check className="h-4 w-4" />
                                {t("acceptedHint")}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="xai-pill-primary"
                                onClick={handleAccept}
                                disabled={accepting}
                              >
                                {accepting ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                                {t("acceptResult")}
                              </button>
                            )}
                            <button
                              type="button"
                              className="xai-pill-outline"
                              onClick={() => handleCreate()}
                              disabled={loading || accepted}
                              title={accepted ? "已确认接受，不能重新匹配" : undefined}
                            >
                              {loading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                              {loading ? t("reMatching") : t("reMatch")}
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* 基准简历来源 + 关键词 */}
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={handleTraceSource}
                        className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
                      >
                        <FileText
                          className="h-3.5 w-3.5 shrink-0"
                          style={{ color: `hsl(${BRAND_VIOLET})` }}
                        />
                        <span className="truncate">
                          {t("masterResume")}：{result.title}
                        </span>
                      </button>

                      {result.keywords?.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <Tag className="h-3.5 w-3.5" />
                            {result.keywords.length}:
                          </span>
                          {result.keywords.map((k) => (
                            <span
                              key={k}
                              className="rounded-full px-2.5 py-1 text-xs font-medium"
                              style={{
                                backgroundColor: `hsl(${BRAND_VIOLET} / 0.1)`,
                                color: `hsl(${BRAND_VIOLET})`,
                              }}
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Tab: 优化简历
                        子视图 1 · preview：A4 预览（MarkdownPreview 自身按 210mm A4
                          分页渲染，内部第一页带 id="resume-preview"，直接用于 PDF 导出）。
                        子视图 2 · compare：左右对比原简历/优化后，高亮修改 + hover 依据。 */}
                    <TabsContent value="resume" className="mt-4">
                      <div className="mb-3 flex items-center justify-end">
                        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                          <button
                            type="button"
                            onClick={() => setResumeView("compare")}
                            className={cn(
                              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                              resumeView === "compare"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            左右对比
                          </button>
                          <button
                            type="button"
                            onClick={() => setResumeView("preview")}
                            className={cn(
                              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                              resumeView === "preview"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            A4 预览
                          </button>
                        </div>
                      </div>
                      {resumeView === "preview" ? (
                        <div className="mx-auto min-h-0 max-w-[820px] rounded-lg border border-border bg-white shadow-sm">
                          <MarkdownPreview
                            markdown={stripMarkdownPreamble(result.markdownContent)}
                            embedded
                          />
                        </div>
                      ) : (
                        <div className="min-h-0 overflow-hidden rounded-lg border border-border">
                          <ResumeDiffView
                            original={
                              selected ? matchBaseText(selected) : result.title
                            }
                            optimized={stripMarkdownPreamble(result.markdownContent)}
                            keywords={result.keywords ?? []}
                            analysis={result.matchAnalysis}
                          />
                        </div>
                      )}
                    </TabsContent>

                    {/* Tab: 匹配分析 —— 双栏：左（匹配总结 + 逐条分析）/ 右（得分环 + 话术） */}
                    <TabsContent value="analysis" className="mt-4">
                      {(() => {
                        const a = result.matchAnalysis;
                        if (!a) return null;
                        const scorePct =
                          typeof a.score === "number" ? Math.round(a.score * 100) : null;
                        const reqs = a.requirements ?? [];
                        const optimizedText = stripMarkdownPreamble(result.markdownContent);
                        const kwTotal = result.keywords?.length ?? 0;
                        const kwHit = kwTotal
                          ? result.keywords.filter((k) =>
                              optimizedText.toLowerCase().includes(String(k).toLowerCase())
                            ).length
                          : 0;
                        // 后端 strength 取值：matched / weak / missing / unspported
                        const reqMeta = (strength: string | undefined) =>
                          strength === "matched"
                            ? {
                                label: t("matchReqMet"),
                                cls: "bg-emerald-500/15 text-emerald-400",
                              }
                            : strength === "weak"
                              ? {
                                  label: t("matchReqPartial"),
                                  cls: "bg-amber-500/15 text-amber-400",
                                }
                              : strength === "missing"
                                ? {
                                    label: t("matchReqMissing"),
                                    cls: "bg-rose-500/15 text-rose-400",
                                  }
                                : {
                                    label: t("matchReqUnsupported"),
                                    cls: "bg-slate-500/20 text-slate-300",
                                  };
                        return (
                          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                            {/* 左栏：匹配总结 + 匹配项逐条分析 */}
                            <div className="min-w-0 flex-1 space-y-4">
                              {(a.summary || a.role) && (
                                <div className="rounded-[10px] border border-border bg-card p-5">
                                  <div className="flex items-center justify-between">
                                    <h3 className="text-[13.5px] font-medium text-foreground">
                                      {t("matchAnalysisSummary")}
                                    </h3>
                                    <span className="xai-eyebrow">SUMMARY</span>
                                  </div>
                                  {a.role && (
                                    <p className="mt-3 text-[13px] text-muted-foreground">
                                      {t("matchAnalysisRole")}：
                                      <span className="font-medium text-foreground">
                                        {a.role}
                                      </span>
                                    </p>
                                  )}
                                  {a.summary && (
                                    <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
                                      {a.summary}
                                    </p>
                                  )}
                                </div>
                              )}

                              {reqs.length > 0 && (
                                <div className="rounded-[10px] border border-border bg-card p-5">
                                  <div className="flex items-center justify-between">
                                    <h3 className="text-[13.5px] font-medium text-foreground">
                                      {t("matchAnalysisRequirements")}
                                    </h3>
                                    <span className="xai-eyebrow">REQ BREAKDOWN</span>
                                  </div>
                                  <ul className="mt-2 divide-y divide-border">
                                    {reqs.map((req, i) => {
                                      const meta = reqMeta(req.strength);
                                      return (
                                        <li
                                          key={i}
                                          className="flex gap-3 py-3.5 first:pt-3 last:pb-0"
                                        >
                                          <span
                                            className={cn(
                                              "mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                                              meta.cls
                                            )}
                                          >
                                            {meta.label}
                                          </span>
                                          <div className="min-w-0">
                                            <p className="text-[13px] font-medium text-foreground">
                                              {req.requirement}
                                            </p>
                                            {req.evidence && (
                                              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                {t("matchReqEvidence")}：{req.evidence}
                                              </p>
                                            )}
                                            {req.suggestion && (
                                              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                {t("matchReqSuggestion")}：{req.suggestion}
                                              </p>
                                            )}
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </div>

                            {/* 右栏：得分环形 + 命中关键词 + 打招呼话术 */}
                            <div className="w-full shrink-0 space-y-4 xl:w-[340px]">
                              <div className="rounded-[10px] border border-border bg-card p-5">
                                <div className="flex items-center justify-between">
                                  <h3 className="text-[13.5px] font-medium text-foreground">
                                    {t("matchAnalysisScore")}
                                  </h3>
                                  <span className="xai-eyebrow">SCORE</span>
                                </div>
                                <div className="mt-4 flex justify-center">
                                  <ScoreRing pct={scorePct ?? 0} />
                                </div>
                                {kwTotal > 0 && (
                                  <div className="mt-4">
                                    <div className="text-[11px] text-muted-foreground">
                                      命中关键词 {kwHit}/{kwTotal}
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                      {result.keywords.map((k) => {
                                        const hit = optimizedText
                                          .toLowerCase()
                                          .includes(String(k).toLowerCase());
                                        return (
                                          <span
                                            key={k}
                                            className={cn(
                                              "rounded-full px-2.5 py-1 text-[11px] font-medium",
                                              hit
                                                ? "bg-emerald-500/15 text-emerald-400"
                                                : "bg-muted text-muted-foreground line-through"
                                            )}
                                          >
                                            {k}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </TabsContent>

                    {/* Tab: 匹配话术（与匹配解耦的独立资源）
                        挂载 CoverLetterPanel：按 derivedResumeId 从 DB 加载历史话术，
                        支持多场景生成 / 列表 / 编辑 / 重生成 / 删除。 */}
                    <TabsContent value="pitch" className="mt-4">
                      <CoverLetterPanel
                        resumeText={selected ? matchBaseText(selected) : ""}
                        jdText={jdText}
                        derivedResumeId={result?.id}
                        jobId={currentJobId ?? undefined}
                      />
                    </TabsContent>
                  </div>
                </ScrollArea>
              </Tabs>
            )}
          </section>

          {/* 小屏抽屉遮罩：仅小屏抽屉（fixed overlay）打开时显示，点击关闭 */}
          {drawerOpen && (
            <div
              className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
          )}
        </div>
      </motion.div>

      {/* JD 失焦查重命中确认：仅提示不拦截，提供「继续机会 / 仍然新建」 */}
      <AlertDialog
        open={!!detectConfirm}
        onOpenChange={(o) => !o && setDetectConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("jobDetectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {detectConfirm
                ? t("jobDetectDesc", {
                    time: relTime(detectConfirm.job.last_activity_at, locale),
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDetectConfirm(null)}>
              {t("jobDetectNew")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (detectConfirm) handleRestoreJob(detectConfirm.job);
                setDetectConfirm(null);
              }}
            >
              {t("jobDetectContinue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 接受后询问：是否立刻编辑简历 */}
      <AlertDialog open={editNowOpen} onOpenChange={setEditNowOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("editNowTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("editNowDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleEditLater}>
              {t("editLater")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleEditNow}>
              {t("editNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
