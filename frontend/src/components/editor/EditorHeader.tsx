import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  Download,
  Edit2,
  Undo2,
  Redo2,
  Save,
  Loader2,
} from "lucide-react";
import { motion } from "framer-motion";
import { useRouter } from "@/lib/navigation";
import { Input } from "@/components/ui/input";
import PdfExport from "../shared/PdfExport";
import ThemeToggle from "../shared/ThemeToggle";
import { useResumeStore } from "@/store/useResumeStore";
import { useGrammarCheck } from "@/hooks/useGrammarCheck";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { GrammarCheckDrawer } from "./grammar/GrammarCheckDrawer";
import { getFileHandle, getConfig } from "@/utils/fileSystem";

interface EditorHeaderProps {
  isMobile?: boolean;
}

export function EditorHeader({ isMobile }: EditorHeaderProps) {
  const {
    activeResume,
    updateResumeTitle,
    undo,
    redo,
    canUndo,
    canRedo,
    saveActiveResumeToBackend,
    syncedIds,
  } = useResumeStore();
  const { errors } = useGrammarCheck();
  const router = useRouter();
  const t = useTranslations();
  const undoLabel = t("richEditor.undo");
  const redoLabel = t("richEditor.redo");

  const [backupConfigured, setBackupConfigured] = useState<boolean | null>(null);
  const [backupPath, setBackupPath] = useState<string>("");

  useEffect(() => {
    const checkBackup = async () => {
      try {
        const handle = await getFileHandle("syncDirectory");
        const path = await getConfig("syncDirectoryPath");
        setBackupConfigured(!!handle);
        setBackupPath(path || "");
      } catch {
        setBackupConfigured(false);
      }
    };
    checkBackup();
  }, []);

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

  // 脏检查：以「最近一次成功保存（或刚从后端加载）的内容」为基准快照，
  // 当前激活简历与其不一致即为未保存修改，保存按钮才可点击。
  const savedSnapshotRef = useRef<string | null>(null);
  if (savedSnapshotRef.current === null) {
    // 已在后端落库的简历以当前内容作基准（初始不脏）；未落库的临时简历
    // 以空字符串作基准，与任何内容都不等 -> 初始即可保存。
    savedSnapshotRef.current =
      activeResume && syncedIds.has(activeResume.id)
        ? JSON.stringify(activeResume)
        : "";
  }
  // 切换简历时重置基准，下个 render 以上一份简历的已存内容为干净起点。
  useEffect(() => {
    savedSnapshotRef.current = null;
  }, [activeResume?.id]);
  const isDirty =
    activeResume != null &&
    JSON.stringify(activeResume) !== savedSnapshotRef.current;

  const handleSaveMatch = async () => {
    if (!activeResume || !isDirty) return;
    setSavingMatch(true);
    try {
      await saveActiveResumeToBackend();
      // 保存成功后，用 store 里的最新内容（落库会刷新 updatedAt）刷新基准，
      // 否则会拿保存前的旧快照对比、导致按钮仍判定为脏、无法置灰。
      const latest = useResumeStore.getState().activeResume;
      savedSnapshotRef.current = latest ? JSON.stringify(latest) : "";
      toast.success(t("jobmatch.saveMatchSuccess"));
    } catch (err) {
      toast.error((err as Error).message || t("jobmatch.saveMatchError"));
    } finally {
      setSavingMatch(false);
    }
  };

  // 快捷键保存：Ctrl+S（Win/Linux）与 Cmd+S（Mac）均触发，阻止浏览器默认「保存网页」。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveMatch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSaveMatch]);

  return (
    <motion.header
      className={`h-16 border-b sticky top-0 z-10`}
      initial={{ y: -100 }}
      animate={{ y: 0 }}
    >
      <div className="flex items-center justify-between px-6 h-full pr-2">
        <div className="flex items-center space-x-3 scrollbar-hide">
          {/* 返回工作台 */}
          <button
            type="button"
            aria-label={t("common.title")}
            onClick={() => router.push("/app/dashboard")}
            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground md:inline-flex"
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

          {/* 标题：pill 输入框 */}
          <div className="relative hidden md:flex items-center group">
            <Input
              key={activeResume?.id || "resume-title"}
              defaultValue={activeResume?.title || ""}
              onBlur={(e) => {
                updateResumeTitle(e.target.value || "未命名简历");
              }}
              className="h-9 w-56 rounded-full border-border bg-transparent px-4 pr-9 text-sm shadow-none transition-colors placeholder:text-muted-foreground/60 hover:border-[#3d4048] focus-visible:border-border focus-visible:ring-1 focus-visible:ring-ring font-medium text-foreground/90 hover:text-foreground"
              placeholder="简历名称"
            />
            <Edit2 className="w-3.5 h-3.5 absolute right-3.5 text-muted-foreground/40 pointer-events-none transition-colors group-hover:text-muted-foreground/80" />
          </div>

          {/* Backup Status Badge */}
          {backupConfigured !== null && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <motion.div
                    className={`
                      hidden md:flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer
                      text-xs font-medium transition-colors ml-2
                      ${backupConfigured
                        ? "text-emerald-600/80 hover:bg-emerald-100/50 dark:text-emerald-500/80 dark:hover:bg-emerald-900/30"
                        : "text-amber-600/80 hover:bg-amber-100/50 dark:text-amber-500/80 dark:hover:bg-amber-900/30"
                      }
                    `}
                    initial={{ opacity: 0, x: -5 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3, duration: 0.3 }}
                    onClick={() => router.push("/app/dashboard/settings")}
                  >
                    {backupConfigured ? (
                      <>
                        <ShieldCheck className="w-4 h-4" />
                        <span>{t("previewDock.backup.configured")}</span>
                      </>
                    ) : (
                      <>
                        <motion.div
                          animate={{ scale: [1, 1.15, 1] }}
                          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                          className="relative"
                        >
                          <ShieldAlert className="w-4 h-4" />
                          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
                        </motion.div>
                        <span>{t("previewDock.backup.notConfigured")}</span>
                      </>
                    )}
                  </motion.div>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={8} className="max-w-[240px]">
                  {backupConfigured ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium">{t("previewDock.backup.configured")}</span>
                      <span className="text-[10px] text-muted-foreground truncate">{backupPath}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium">{t("previewDock.backup.notConfigured")}</span>
                      <span className="text-[10px] text-muted-foreground">{t("previewDock.backup.clickToConfigure")}</span>
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        <div className="flex items-center flex-wrap gap-x-3 gap-y-2">
          <div className="hidden md:flex items-center gap-1">
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={undo}
                    disabled={!canUndo()}
                    aria-label={undoLabel}
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{undoLabel}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={redo}
                    disabled={!canRedo()}
                    aria-label={redoLabel}
                  >
                    <Redo2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{redoLabel}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <GrammarCheckDrawer />
          {errors.length > 0 && (
             <div 
                className="flex items-center space-x-1 cursor-pointer animate-pulse"
                onClick={() => document.dispatchEvent(new CustomEvent('open-grammar-drawer'))}
             >
                  <AlertCircle className="w-4 h-4 text-red-500" />
                  <span className="text-sm text-red-500">
                    {t("grammarCheck.found_issues", { count: errors.length })}
                  </span>
             </div>
          )}

          <ThemeToggle></ThemeToggle>
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white px-4 text-[13px] font-medium text-[#0A0A0A] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[#292B33] px-4 text-[13px] text-[#E7E9EC] transition-colors hover:border-[#3d4048] hover:text-white"
              >
                <Download className="h-4 w-4" />
                {t("pdfExport.button.export")}
              </button>
            </PdfExport>
          </div>
        </div>
      </div>
    </motion.header>
  );
}
