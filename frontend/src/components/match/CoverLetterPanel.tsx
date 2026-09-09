// 话术面板：与简历匹配解耦的独立资源。
// 支持多场景（打招呼 / 跟进 / 邀约）生成、列表查看、二次编辑、重生成、删除。
// 话术与匹配共享「积分」：每次生成 / 重生成消耗 1 积分，编辑 / 删除不消耗。
import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import { Loader2, Mail, Copy, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  createCoverLetter,
  listCoverLetters,
  getCoverLetter,
  updateCoverLetter,
  deleteCoverLetter,
  regenerateCoverLetter,
  type CoverLetter,
  type CoverLetterScene,
} from "@/lib/jobmatch";
import { useAuthStore } from "@/store/useAuthStore";

const SCENES: CoverLetterScene[] = ["greeting", "followup", "interview"];

// i18n 键与场景一一对应（pitchGreeting / pitchFollowup / pitchInterview）
const SCENE_KEY: Record<CoverLetterScene, string> = {
  greeting: "pitchGreeting",
  followup: "pitchFollowup",
  interview: "pitchInterview",
};

interface CoverLetterPanelProps {
  /** 简历文本（生成基准，来自当前选中的主简历） */
  resumeText: string;
  /** 岗位描述 */
  jdText: string;
  /** 关联衍生简历（匹配结果）id：传入后列表仅显示该匹配的话术 */
  derivedResumeId?: string;
  /**
   * 聚焦单条话术：仅展示这一条。
   * 用于「仅话术」模式——该话术不关联任何匹配结果，若走列表会混入其他匹配的话术。
   */
  focusId?: string;
  /** 按岗位卡过滤话术（与 derivedResumeId 可同时给，后端按 AND）；用于恢复岗位后展示其话术 */
  jobId?: string;
}

export default function CoverLetterPanel({
  resumeText,
  jdText,
  derivedResumeId,
  focusId,
  jobId,
}: CoverLetterPanelProps) {
  const t = useTranslations("jobmatch");
  const applyCredits = useAuthStore((s) => s.applyCredits);

  const [scene, setScene] = useState<CoverLetterScene>("greeting");
  const [letters, setLetters] = useState<CoverLetter[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  // 重生成 / 删除进行中的话术 id（防重复点击）
  const [busyId, setBusyId] = useState<string | null>(null);

  const canGenerate = resumeText.trim().length > 0 && jdText.trim().length > 0;

  // 进入面板即从 DB 加载已保存话术（不依赖内存中的匹配结果）。
  // - focusId：仅话术模式，直取单条；
  // - 否则按 derivedResumeId 过滤（未传则列出该用户全部话术）。
  // 依赖变化（切换匹配 / 切换聚焦话术）时重新拉取。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (focusId) {
          const one = await getCoverLetter(focusId);
          if (!cancelled) {
            setLetters([one]);
            setActiveId(one.id);
          }
          return;
        }
        const list = await listCoverLetters(derivedResumeId, jobId);
        if (!cancelled) setLetters(list);
      } catch (err) {
        console.error("加载话术失败:", err);
        if (!cancelled) setLetters([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [derivedResumeId, focusId, jobId]);

  async function handleGenerate() {
    if (!canGenerate) {
      toast.warning(t("pitchNeedResumeJd"));
      return;
    }
    setGenerating(true);
    try {
      const created = await createCoverLetter({
        resume_text: resumeText,
        jd_text: jdText,
        scene,
        derived_resume_id: derivedResumeId,
      });
      // 生成消耗积分：用后端返回的剩余积分刷新侧边栏
      if (typeof created.remaining_credits === "number") {
        applyCredits(created.remaining_credits);
      }
      setLetters((prev) => [created, ...prev]);
      setActiveId(created.id);
      toast.success(t("pitchGenerated"));
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      // 403=积分不足；其余走通用文案
      toast.error(
        status === 403 ? (err as Error).message : t("pitchGenerateError")
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleRegenerate(id: string) {
    setBusyId(id);
    try {
      const updated = await regenerateCoverLetter(id, { scene });
      if (typeof updated.remaining_credits === "number") {
        applyCredits(updated.remaining_credits);
      }
      setLetters((prev) => prev.map((l) => (l.id === id ? updated : l)));
      setActiveId(id);
      toast.success(t("pitchRegenerated"));
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      toast.error(
        status === 403 ? (err as Error).message : t("pitchRegenerateError")
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleSaveEdit(id: string) {
    try {
      const updated = await updateCoverLetter(id, { content: editContent });
      setLetters((prev) => prev.map((l) => (l.id === id ? updated : l)));
      setEditingId(null);
      toast.success(t("pitchSaved"));
    } catch (err) {
      console.error("保存话术失败:", err);
      toast.error(t("pitchSaveError"));
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      await deleteCoverLetter(id);
      setLetters((prev) => prev.filter((l) => l.id !== id));
      if (activeId === id) setActiveId(null);
      toast.success(t("pitchDeleted"));
    } catch (err) {
      console.error("删除话术失败:", err);
      toast.error(t("pitchDeleteError"));
    } finally {
      setBusyId(null);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("pitchCopied"));
    } catch {
      toast.error(t("pitchCopyError"));
    }
  }

  return (
    <div className="space-y-4">
      {/* 头部：标题 + 场景切换 + 生成按钮 */}
      <div className="rounded-[10px] border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
            <Mail className="h-4 w-4" />
            {t("matchAnalysisCoverLetter")}
          </h3>
          <span className="xai-eyebrow">PITCH</span>
        </div>

        {/* 场景切换（打招呼 / 跟进 / 邀约） */}
        <div className="mt-3 inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
          {SCENES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScene(s)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                scene === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(SCENE_KEY[s])}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("pitchQuotaHint")}
          </p>
          <button
            type="button"
            className="xai-pill-primary shrink-0"
            onClick={handleGenerate}
            disabled={generating || !canGenerate}
            title={canGenerate ? undefined : t("pitchNeedResumeJd")}
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {generating ? t("pitchGenerating") : t("pitchGenerate")}
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="space-y-3">
        {loading ? (
          <div className="rounded-[10px] border border-border bg-card p-5 text-[13px] text-muted-foreground">
            {t("pitchLoading")}
          </div>
        ) : letters.length === 0 ? (
          <div className="rounded-[10px] border border-border bg-card p-6 text-center text-[13px] text-muted-foreground">
            {t("pitchEmpty")}
          </div>
        ) : (
          letters.map((l) => {
            const isActive = activeId === l.id;
            const isEditing = editingId === l.id;
            const isBusy = busyId === l.id;
            return (
              <div
                key={l.id}
                className="rounded-[10px] border border-border bg-card p-5"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/12 px-2.5 py-0.5 text-[11px] font-medium text-violet-500">
                    {t(SCENE_KEY[l.scene])}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(l.updated_at).toLocaleString()}
                  </span>
                </div>

                {/* 编辑态：textarea + 保存/取消 */}
                {isEditing ? (
                  <div className="mt-3 space-y-3">
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={6}
                      className="text-[13px] leading-relaxed"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="xai-pill-outline"
                        onClick={() => setEditingId(null)}
                      >
                        {t("pitchCancel")}
                      </button>
                      <button
                        type="button"
                        className="xai-pill-primary"
                        onClick={() => handleSaveEdit(l.id)}
                      >
                        {t("pitchSave")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p
                    onClick={() => setActiveId(isActive ? null : l.id)}
                    className={cn(
                      "mt-3 cursor-pointer whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-3 text-[13px] leading-relaxed text-muted-foreground",
                      !isActive && "line-clamp-3"
                    )}
                  >
                    {l.content}
                  </p>
                )}

                {!isEditing && (
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <span className="mr-auto text-[10px] text-muted-foreground">
                      {l.content.length} 字
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-xai-hairline-strong hover:text-xai-text"
                      onClick={() => copy(l.content)}
                    >
                      <Copy className="h-3 w-3" />
                      {t("pitchCopy")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-xai-hairline-strong hover:text-xai-text"
                      onClick={() => {
                        setEditingId(l.id);
                        setEditContent(l.content);
                        setActiveId(l.id);
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                      {t("pitchEdit")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-xai-hairline-strong hover:text-xai-text disabled:opacity-50"
                      onClick={() => handleRegenerate(l.id)}
                      disabled={isBusy}
                    >
                      {isBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {t("pitchRegenerate")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-3 text-xs text-rose-400 transition-colors hover:border-rose-400/40"
                      onClick={() => handleDelete(l.id)}
                      disabled={isBusy}
                    >
                      <Trash2 className="h-3 w-3" />
                      {t("pitchDelete")}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
