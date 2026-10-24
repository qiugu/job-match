import React, { useCallback } from "react";
import { Home, Copy, Download, Eye } from "lucide-react";
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
import { useResumeStore } from "@/store/useResumeStore";
import { FAQDialog } from "./FAQDialog";
import PdfExport from "@/components/shared/PdfExport";
import { cn } from "@/lib/utils";

interface PreviewDockProps {
  previewPanelCollapsed: boolean;
  togglePreviewPanel: () => void;
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
  previewPanelCollapsed,
  togglePreviewPanel
}: PreviewDockProps) => {
  const router = useRouter();
  const t = useTranslations("previewDock");

  const { duplicateResume, setActiveResume, activeResumeId } = useResumeStore();

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
                      previewPanelCollapsed
                        ? t("previewPanel.expand")
                        : t("previewPanel.collapse")
                    }
                    onClick={togglePreviewPanel}
                    className={cn(
                      dockButtonClass,
                      // 选中态：预览面板展开（未收起）时按钮高亮，与收起态形成可辨识对比
                      !previewPanelCollapsed &&
                        "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                    )}
                  >
                    <Eye className="h-4 w-4" />
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
