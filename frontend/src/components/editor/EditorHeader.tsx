import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import {
  ArrowLeft,
  Download,
  Edit2,
  Undo2,
  Redo2,
  Save,
  Loader2,
} from "lucide-react";
import { motion } from "framer-motion";
import { useRouter } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import PdfExport from "../shared/PdfExport";
import ThemeToggle from "../shared/ThemeToggle";
import { useResumeStore } from "@/store/useResumeStore";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

/**
 * 顶部工具行的唯一尺寸口径：**36px 高 · 8px 圆角**。
 *
 * 修复「最顶部按钮高度不一样」：此前同一排并存 40px（Button 的 icon 档默认
 * 高度，用于主题切换/撤销重做）、36px（手写 h-9 的保存/导出）与 32px（h-8
 * 的 ghost 图标钮）三种高度，基线各不相同，视觉上参差不齐。
 * 这里把高度、圆角、字号、内边距收敛到一组常量，新增控件直接复用，
 * 不再各写一套。
 */
const CTRL_H = "h-9";
const CTRL_BASE = cn(
  "inline-flex shrink-0 items-center justify-center rounded-lg",
  CTRL_H,
  "text-[13px] transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40"
);
/** 次要操作（描边） */
const CTRL_SECONDARY = cn(
  CTRL_BASE,
  "gap-1.5 border border-line-strong px-3.5 font-medium text-ink-2",
  "hover:border-ink hover:bg-paper-2 hover:text-ink"
);
/** 主操作（钴蓝实底，全站唯一信号色） */
const CTRL_PRIMARY = cn(
  CTRL_BASE,
  "gap-1.5 border border-cobalt bg-cobalt px-4 font-semibold text-paper",
  "hover:border-cobalt-deep hover:bg-cobalt-deep",
  "disabled:cursor-not-allowed disabled:opacity-40"
);
/** 纯图标按钮（撤销 / 重做 / 主题） */
const CTRL_ICON = cn(
  CTRL_BASE,
  "w-9 text-ink-2 hover:bg-paper-2 hover:text-ink",
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
);

// 顶部工具行无入参：响应式适配由各自的 `hidden md:*` 断点处理，
// 不再从页面层层下传 isMobile（该参数已无消费者）。
export function EditorHeader() {
  const {
    activeResume,
    updateResumeTitle,
    undo,
    redo,
    canUndo,
    canRedo,
    saveActiveResumeToBackend,
    syncedIds,
    savedSnapshots,
  } = useResumeStore();
  const router = useRouter();
  const t = useTranslations();
  const undoLabel = t("richEditor.undo");
  const redoLabel = t("richEditor.redo");

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      return (
        target.isContentEditable ||
        target.closest("[contenteditable='true']") ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const isModifierPressed = event.metaKey || event.ctrlKey;
      if (!isModifierPressed || isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }

      if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  const [savingMatch, setSavingMatch] = useState(false);

  // 脏检查（修复 I2）：基准快照由 store 统一维护（savedSnapshots），
  // 手动保存、自动保存、后端加载都会刷新它，因此「自动存完仍显示未保存」
  // 的旧故障不再出现。未落库的临时简历没有干净基准，始终视为可保存。
  const isDirty = useMemo(() => {
    if (!activeResume) return false;
    if (!syncedIds.has(activeResume.id)) return true;
    const baseline = savedSnapshots[activeResume.id];
    if (baseline === undefined) return true;
    return JSON.stringify(activeResume) !== baseline;
  }, [activeResume, syncedIds, savedSnapshots]);

  const handleSaveMatch = async () => {
    if (!activeResume || !isDirty) return;
    setSavingMatch(true);
    try {
      // store 的 syncResumeToBackend 成功后会自行刷新 savedSnapshots，
      // 这里不再手动维护基准，避免两处真相（I2）。
      await saveActiveResumeToBackend();
      toast.success(t("jobmatch.saveMatchSuccess"));
    } catch (err) {
      toast.error((err as Error).message || t("jobmatch.saveMatchError"));
    } finally {
      setSavingMatch(false);
    }
  };

  // 快捷键保存：Ctrl+S（Win/Linux）与 Cmd+S（Mac）均触发，阻止浏览器默认「保存网页」。
  // 用 ref 持有最新 handler，effect 只在挂载时绑定一次（修复 I14：旧实现每个按键
  // 都因 handleSaveMatch 引用变化而重绑 window keydown）。
  const saveHandlerRef = useRef(handleSaveMatch);
  useEffect(() => {
    saveHandlerRef.current = handleSaveMatch;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveHandlerRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header
      className={`h-16 border-b border-line sticky top-0 z-10 bg-card`}
    >
      <div className="flex items-center justify-between px-6 h-full pr-2">
        <div className="flex items-center space-x-3 scrollbar-hide">
          {/* 返回工作台 */}
          <button
            type="button"
            aria-label={t("common.title")}
            onClick={() => router.push("/app/dashboard")}
            className={cn(CTRL_ICON, "hidden md:inline-flex")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <motion.div
            className="flex items-center space-x-2 shrink-0 cursor-pointer"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              router.push("/app/dashboard");
            }}
          >
            <span className="text-[15px] font-medium">{t("common.title")}</span>
          </motion.div>

          <span className="text-muted-foreground/30 hidden md:inline-block font-light">/</span>

          {/* 标题：pill 输入框 + 保存状态点（设计稿 03 ed__name） */}
          <div className="relative hidden md:flex items-center group">
            {/* I11：此输入框是「简历文件名」，决定列表页/导出文件名，与正文 H1
                （Markdown 首行）是两个真源。用 aria-label/placeholder 明确语义，
                并补 Enter 提交、Esc 取消，宽度放宽避免长标题被截断。 */}
            <Input
              key={activeResume?.id || "resume-title"}
              defaultValue={activeResume?.title || ""}
              aria-label="简历文件名"
              title="简历文件名（不影响正文标题）"
              onBlur={(e) => {
                updateResumeTitle(e.target.value || "未命名简历");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.currentTarget.value = activeResume?.title || "";
                  e.currentTarget.blur();
                }
              }}
              className="h-9 w-64 max-w-[36vw] rounded-full border-border bg-transparent px-4 pr-9 text-sm shadow-none transition-colors placeholder:text-muted-foreground/60 hover:border-xai-hairline-strong focus-visible:border-border focus-visible:ring-1 focus-visible:ring-ring font-medium text-foreground/90 hover:text-foreground"
              placeholder="简历文件名"
            />
            <Edit2 className="w-3.5 h-3.5 absolute right-3.5 text-muted-foreground/40 pointer-events-none transition-colors group-hover:text-muted-foreground/80" />
          </div>
          {/* 保存状态：中文小标签不用 mono + 字距（会拉散汉字），
              与 .eb-zh 同口径（正文体 / 10.5px / 600 / 0 字距）。 */}
          <span className="eb-zh hidden md:flex items-center gap-1.5 text-[10.5px] text-ink-3">
            <i
              className={cn(
                "w-[5px] h-[5px] rounded-full shrink-0",
                isDirty ? "bg-tangerine" : "bg-green"
              )}
            />
            {isDirty
              ? t("markdownEditor.typeset.unsaved")
              : t("markdownEditor.typeset.saved")}
            {activeResume?.updatedAt
              ? ` · ${new Date(activeResume.updatedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : ""}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center">
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={CTRL_ICON}
                    onClick={undo}
                    disabled={!canUndo()}
                    aria-label={undoLabel}
                  >
                    <Undo2 className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{undoLabel}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={CTRL_ICON}
                    onClick={redo}
                    disabled={!canRedo()}
                    aria-label={redoLabel}
                  >
                    <Redo2 className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{redoLabel}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* 分组竖线：与 icon 按钮同高的一半，只做视觉分组，不占点击区 */}
          <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-line md:block" />

          <ThemeToggle
            className={cn(
              CTRL_ICON,
              "border-0 bg-transparent shadow-none hover:bg-paper-2"
            )}
          />

          {/* 校对入口已回归右侧 PreviewDock（与模板/导出/复制同属「对预览内容
              的操作」）。此前放进顶部工具行，既让顶部多出一个与保存同权重的
              按钮，也与 Dock 里已有的同类操作割裂。 */}

          <TooltipProvider delayDuration={100}>
            <Tooltip>
              {/* I13：用一个可接收指针事件的 span 作为 Tooltip 触发器包住
                  disabled 按钮——禁用元素不派发 pointer 事件，直接用按钮作触发器
                  会让「内容未改动，无需保存」的说明永远不显示。 */}
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0">
                  <button
                    type="button"
                    className={CTRL_PRIMARY}
                    onClick={handleSaveMatch}
                    disabled={savingMatch || !isDirty}
                  >
                    {savingMatch ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {t("jobmatch.saveMatch")}
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isDirty ? t("jobmatch.saveMatchHint") : "内容未改动，无需保存"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div className="shrink-0">
            <PdfExport>
              <button
                type="button"
                className={CTRL_SECONDARY}
              >
                <Download className="h-4 w-4" />
                {t("pdfExport.button.export")}
              </button>
            </PdfExport>
          </div>
        </div>
      </div>
    </header>
  );
}
