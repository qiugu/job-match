import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useTranslations } from "@/i18n/compat/client";
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
  Copy,
  Crosshair,
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
  type CreateMatchPayload,
  type MasterResumeSummary,
  type MatchResult,
} from "@/lib/jobmatch";

// 把毫秒格式化为「秒.十分位」，如 1.2s / 12.3s；超过 60s 显示 m:ss
function formatElapsed(ms: number): string {
  if (ms < 1000) return "0.0s";
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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
          stroke="#26282E"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#6FD79E"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[28px] leading-none text-white">
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
  const router = useRouter();
  const { syncResumeToBackend } = useResumeStore();
  // 左侧「匹配配置 / JD」抽屉：默认打开；收起后结果区占满剩余宽度
  const [drawerOpen, setDrawerOpen] = useState(true);

  const [masters, setMasters] = useState<MasterResumeSummary[]>([]);
  const [selected, setSelected] = useState<ResumeSource | null>(null);
  const [jdText, setJdText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [accepted, setAccepted] = useState<boolean>(false);
  const [accepting, setAccepting] = useState<boolean>(false);
  // 接受后询问「是否立刻编辑简历」的弹窗；pendingMasterId 为落库的 master resume id
  const [editNowOpen, setEditNowOpen] = useState<boolean>(false);
  const [pendingMasterId, setPendingMasterId] = useState<string | null>(null);
  // 结果区当前 tab：匹配分析（默认） / 简历
  const [resultTab, setResultTab] = useState<"resume" | "analysis">("analysis");
  // 「优化简历」内部子视图：A4 预览（用于 PDF 导出） / 左右对比（高亮修改 + hover 依据）
  const [resumeView, setResumeView] = useState<"preview" | "compare">("compare");

  const formCardRef = useRef<HTMLDivElement>(null);
  const resultCardRef = useRef<HTMLDivElement>(null);

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

  const handleCreate = async () => {
    if (!selected) {
      toast.warning(t("selectResumeFirst"));
      return;
    }
    const baseText = matchBaseText(selected);
    if (!baseText.trim()) {
      toast.warning(t("emptyResumeText"));
      return;
    }
    if (!jdText.trim()) return;
    setLoading(true);
    setResult(null);
    setElapsedMs(0);
    const startedAt = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    try {
      const payload: CreateMatchPayload = {
        resumeText: baseText,
        jdText,
        title: selected.title,
      };
      const data = await createMatch(payload);
      setResult(data);
      setAccepted(Boolean(data.accepted));
      // 匹配会扣一次额度：用后端返回的剩余次数刷新侧边栏显示
      if (typeof data.remainingQuota === "number") {
        useAuthStore.getState().applyQuota(data.remainingQuota);
      }
    } catch (err) {
      console.error("Match failed:", err);
      // 403=匹配次数已用完：直接展示后端提示，其余错误走通用文案
      const status = (err as Error & { status?: number }).status;
      toast.error(status === 403 ? (err as Error).message : t("matchError"));
    } finally {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setLoading(false);
    }
  };

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
                    placeholder={t("jdPlaceholder")}
                    disabled={loading}
                    className="min-h-[160px] resize-y border-border bg-muted/40 text-card-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary/20"
                  />
                </div>

                {/* 开始匹配 */}
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={loading || !selected}
                  className="group flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground font-semibold transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Crosshair className="h-4 w-4 transition-transform group-hover:rotate-90" />
                  )}
                  {loading ? t("matching") : t("startMatch")}
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
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `hsl(${BRAND_VIOLET} / 0.12)` }}
                >
                  <Target className="h-4.5 w-4.5" style={{ color: `hsl(${BRAND_VIOLET})` }} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">{t("result")}</h2>
                  <p className="truncate text-xs text-muted-foreground">
                    {result ? result.title : t("resultEmpty")}
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
                  {t("matchingDesc")}
                  <span className="ml-auto tabular-nums font-medium">
                    {formatElapsed(elapsedMs)}
                  </span>
                </div>
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
              </div>
            ) : !result ? (
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
                            <div className="font-mono text-[24px] leading-none text-white">
                              {scorePct ?? "—"}
                              {scorePct !== null && <span className="text-sm">%</span>}
                            </div>
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              综合匹配得分
                            </div>
                          </div>
                          <div className="h-9 w-px shrink-0 bg-border" />
                          <div className="shrink-0">
                            <div className="font-mono text-[24px] leading-none text-[#7BE0A5]">
                              {kwHit}/{kwTotal}
                            </div>
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              关键词命中
                            </div>
                          </div>
                          <div className="h-9 w-px shrink-0 bg-border" />
                          <div className="shrink-0">
                            <div className="text-[20px] font-medium leading-none text-white">
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
                              onClick={handleCreate}
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
                        const letter = a.cover_letter ?? "";
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

                              {/* 匹配话术（cover_letter）：resume_match 节点输出；
                                  顶层「求职信」tab 的 coverLetter 直接复用同一字段
                                  （withCoverLetter=true 时返回），两者内容一致。 */}
                              {letter && (
                                <div className="rounded-[10px] border border-border bg-card p-5">
                                  <div className="flex items-center justify-between">
                                    <h3 className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
                                      <Mail className="h-4 w-4" />
                                      {t("matchAnalysisCoverLetter")}
                                    </h3>
                                    <button
                                      type="button"
                                      className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-[#3d4048] hover:text-white"
                                      onClick={async () => {
                                        try {
                                          await navigator.clipboard.writeText(letter);
                                          toast.success("已复制打招呼话术");
                                        } catch {
                                          toast.error("复制失败，请手动选择复制");
                                        }
                                      }}
                                    >
                                      <Copy className="h-3 w-3" />
                                      复制
                                    </button>
                                  </div>
                                  <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-3 text-[13px] leading-relaxed text-muted-foreground">
                                    {letter}
                                  </p>
                                  <p className="mt-2 text-right text-[10px] text-muted-foreground">
                                    {letter.length} 字
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
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
