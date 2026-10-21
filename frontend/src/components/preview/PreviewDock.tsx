import React, { useCallback } from "react";
import {
  Edit2,
  SpellCheck2,
  Home,
  Copy,
  Download,
  Eye,
  FileText
} from "lucide-react";
import { PanelsLeftBottom } from "lucide-react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { Dock, DockIcon } from "@/components/magicui/dock";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import TemplateSheet from "@/components/shared/TemplateSheet";
import { cn } from "@/lib/utils";
import { useGrammarCheck } from "@/hooks/useGrammarCheck";
import { useResumeStore } from "@/store/useResumeStore";
import { FAQDialog } from "./FAQDialog";
import PdfExport from "@/components/shared/PdfExport";

interface PreviewDockProps {
  editPanelCollapsed: boolean;
  previewPanelCollapsed: boolean;
  toggleEditPanel: () => void;
  togglePreviewPanel: () => void;
  resumeContentRef: React.RefObject<HTMLDivElement>;
}

const MagicThread = ({ height = 40 }: { height?: number }) => (
  <div className="relative flex flex-col items-center" style={{ height }}>
    {/* Base dashed line */}
    <div className="absolute inset-y-0 w-[1px] border-l border-dashed border-primary/30" />

    {/* Traveling pulse */}
    <motion.div
      className="absolute top-0 w-[1px] h-4 bg-gradient-to-b from-transparent via-primary to-transparent"
      animate={{
        top: ["0%", "100%"],
        opacity: [0, 1, 0],
      }}
      transition={{
        duration: 2.5,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  </div>
);
const PreviewDock = ({
  editPanelCollapsed,
  previewPanelCollapsed,
  toggleEditPanel,
  togglePreviewPanel,
  resumeContentRef
}: PreviewDockProps) => {
  const router = useRouter();
  const t = useTranslations("previewDock");
  const { checkGrammar, isChecking } = useGrammarCheck();

  const { duplicateResume, setActiveResume, activeResumeId, activeResume, updateGlobalSettings } = useResumeStore();
  const { globalSettings = {} } = activeResume || {};

  // ... (keep other hooks)

  const handleGrammarCheck = useCallback(async () => {
    try {
      const previewContent =
        resumeContentRef.current || document.getElementById("resume-preview");
      if (!previewContent) {
        toast.error(t("grammarCheck.errorToast"));
        return;
      }

      const text = previewContent.innerText?.trim();
      if (!text) {
        toast.error(t("grammarCheck.errorToast"));
        return;
      }

      await checkGrammar(text);
    } catch (error) {
      toast.error(t("grammarCheck.errorToast"));
    }
  }, [resumeContentRef, checkGrammar, t]);

  const handleCopyResume = useCallback(() => {
    if (!activeResumeId) return;
    try {
      const newId = duplicateResume(activeResumeId);
      const targetPath = `/app/workbench/${newId}`;
      setActiveResume(newId);
      toast.success(t("copyResume.success"));
      router.push({ to: "/app/workbench/$id", params: { id: newId } });

      requestAnimationFrame(() => {
        if (window.location.pathname !== targetPath) {
          window.location.assign(targetPath);
        }
      });
    } catch (error) {
      toast.error(t("copyResume.error"));
    }
  }, [activeResumeId, duplicateResume, router, setActiveResume, t]);

  const dockButtonClass =
    "flex h-7 w-7 items-center justify-center rounded-lg transition-all hover:bg-muted/50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";
  const panelButtonClass =
    "flex h-[30px] w-[30px] items-center justify-center rounded-sm transition-all hover:bg-muted/50 active:scale-95";

  return (
    <div className="fixed right-3 top-1/2 z-[50] hidden -translate-y-1/2 flex-col items-center md:flex">
      <TooltipProvider delayDuration={0}>
        <Dock className="mb-0 border border-border/40 bg-background/80 shadow-xl">
          <div className="flex flex-col gap-2">
            <DockIcon>
              <Tooltip>
                <TemplateSheet
                  trigger={
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("switchTemplate")}
                        className={dockButtonClass}
                      >
                        <PanelsLeftBottom className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                  }
                />
                <TooltipContent side="left" sideOffset={10}>
                  <p>{t("switchTemplate")}</p>
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <DockIcon>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={
                      isChecking
                        ? t("grammarCheck.checking")
                        : t("grammarCheck.idle")
                    }
                    disabled={isChecking}
                    className={cn(dockButtonClass, isChecking && "animate-pulse")}
                    onClick={handleGrammarCheck}
                  >
                    <SpellCheck2
                      className={cn("h-4 w-4", isChecking && "animate-spin")}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>
                  <p>
                    {isChecking
                      ? t("grammarCheck.checking")
                      : t("grammarCheck.idle")}
                  </p>
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <DockIcon>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("autoOnePage.tooltip")}
                    className={cn(
                      dockButtonClass,
                      globalSettings?.autoOnePage &&
                        "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                    )}
                    onClick={() => {
                      updateGlobalSettings({
                        autoOnePage: !globalSettings?.autoOnePage,
                      });
                      toast.success(
                        globalSettings?.autoOnePage
                          ? t("autoOnePage.disabled")
                          : t("autoOnePage.enabled")
                      );
                    }}
                  >
                    <FileText className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>
                  <p>{t("autoOnePage.tooltip")}</p>
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <DockIcon>
              <Tooltip>
                <PdfExport>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("export.tooltip")}
                      className={dockButtonClass}
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                </PdfExport>
                <TooltipContent side="left" sideOffset={10}>
                  <p>{t("export.tooltip")}</p>
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <DockIcon>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("copyResume.tooltip")}
                    className={dockButtonClass}
                    onClick={handleCopyResume}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>
                  <p>{t("copyResume.tooltip")}</p>
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <div className="h-[1px] w-full bg-border" />

            <DockIcon>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={
                      editPanelCollapsed
                        ? t("editPanel.expand")
                        : t("editPanel.collapse")
                    }
                    disabled={!editPanelCollapsed && previewPanelCollapsed}
                    onClick={toggleEditPanel}
                    className={cn(
                      panelButtonClass,
                      !editPanelCollapsed &&
                        "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                    )}
                  >
                    <Edit2 size={20} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>
                  {editPanelCollapsed
                    ? t("editPanel.expand")
                    : t("editPanel.collapse")}
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <DockIcon>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={
                      previewPanelCollapsed
                        ? t("previewPanel.expand")
                        : t("previewPanel.collapse")
                    }
                    disabled={!previewPanelCollapsed && editPanelCollapsed}
                    onClick={togglePreviewPanel}
                    className={cn(
                      panelButtonClass,
                      !previewPanelCollapsed &&
                        "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                    )}
                  >
                    <Eye size={20} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>
                  {previewPanelCollapsed
                    ? t("previewPanel.expand")
                    : t("previewPanel.collapse")}
                </TooltipContent>
              </Tooltip>
            </DockIcon>

            <div className="h-[1px] w-full bg-border" />

            <DockIcon>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("backToDashboard")}
                    className={dockButtonClass}
                    onClick={() => router.push("/app/dashboard")}
                  >
                    <Home className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={10}>
                  <p>{t("backToDashboard")}</p>
                </TooltipContent>
              </Tooltip>
            </DockIcon>
          </div>
        </Dock>
      </TooltipProvider>

      <MagicThread height={60} />

      <div className="flex w-[56px] justify-center">
        <FAQDialog />
      </div>
    </div>
  );
};

export default PreviewDock;
