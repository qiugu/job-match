import React, { useReducer, useState } from "react";
import { useTranslations } from "@/i18n/compat/client";
import {
  ChevronDown,
  Download,
  FileText,
  Loader2,
  Printer,
  ShieldCheck,
} from "lucide-react";
import { useResumeStore } from "@/store/useResumeStore";
import { DEFAULT_PAGE_PADDING } from "@/types/resume";
import { Button } from "@/components/ui/button";
import { exportToServerPdf } from "@/utils/pdfExportServer";
import { exportResumeToBrowserPrint } from "@/utils/print";
import { cn } from "@/lib/utils";
import {
  PDF_EXPORT_PROGRESS,
  PDF_EXPORT_LAYOUTS,
  getPdfExportDisplayPhase,
  initialPdfExportState,
  isPdfExporting,
  pdfExportInteractionReducer,
} from "@/utils/pdfExportInteraction";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const ExportOption = ({
  icon: Icon,
  eyebrow,
  title,
  description,
  onClick,
  isLoading,
  featured = false,
}: {
  icon: React.ElementType | any,
  eyebrow: string,
  title: string,
  description: string,
  onClick: () => void,
  isLoading: boolean,
  featured?: boolean,
}) => {
  return (
    <button
      type="button"
      disabled={isLoading}
      aria-busy={isLoading}
      onClick={onClick}
      className={cn(
        "group flex h-[132px] w-full flex-col justify-between rounded-xl border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        featured
          ? "border-foreground bg-foreground text-background hover:bg-foreground/90"
          : "border-border/80 bg-background text-foreground hover:border-foreground/40 hover:bg-muted/40",
        isLoading && "cursor-not-allowed opacity-60"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-lg border",
            featured
              ? "border-background/20 bg-background/10"
              : "border-border/80 bg-muted/50"
          )}
        >
          <Icon className="size-4" strokeWidth={1.8} />
        </span>
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.16em]",
            featured ? "text-background/60" : "text-muted-foreground/70"
          )}
        >
          {eyebrow}
        </span>
      </div>
      <div>
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        <p
          className={cn(
            "mt-1 text-[12px] leading-[1.45]",
            featured ? "text-background/65" : "text-muted-foreground"
          )}
        >
          {description}
        </p>
      </div>
    </button>
  );
};

const PdfExport = ({ children }: { children?: React.ReactNode }) => {
  const [exportState, dispatchExportState] = useReducer(
    pdfExportInteractionReducer,
    initialPdfExportState
  );
  const [isPrinting, setIsPrinting] = useState(false);
  // 暂时不支持 JSON / Markdown 导出，相关状态先注释
  // const [isExportingJson, setIsExportingJson] = useState(false);
  // const [isExportingMarkdown, setIsExportingMarkdown] = useState(false);
  const { activeResume } = useResumeStore();
  const { globalSettings = {}, title } = activeResume || {};
  const t = useTranslations("pdfExport");
  const tBasicField = useTranslations("workbench.basicPanel.basicFields");
  const isExporting = isPdfExporting(exportState);
  const isBusy = isExporting || isPrinting;

  const handleExport = async () => {
    if (isBusy) return;

    dispatchExportState({ type: "start" });
    // 服务端 headless Chromium 矢量导出：文字可选中/可搜索、体积小。
    // 服务不可用时（渲染组件缺失/超时/限流）由 toast 提示改用打印，
    // 不再降级 html2pdf。
    const didExport = await exportToServerPdf({
      elementId: "resume-preview",
      title: title || "resume",
      pagePadding: globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING,
      fontFamily: globalSettings?.fontFamily,
      onProgress: (phase) => dispatchExportState({ type: "progress", phase }),
      successMessage: t("toast.success"),
      errorMessage: t("toast.error")
    });
    dispatchExportState({ type: "finish", success: didExport });
  };

  // 暂时不支持 JSON / Markdown 导出，相关处理函数先注释
  // const handleJsonExport = () => {
  //   exportResumeAsJson({
  //     resume: activeResume,
  //     title,
  //     onStart: () => setIsExportingJson(true),
  //     onEnd: () => setIsExportingJson(false),
  //     successMessage: t("toast.jsonSuccess"),
  //     errorMessage: t("toast.jsonError")
  //   });
  // };

  // const handleMarkdownExport = () => {
  //   exportResumeAsMarkdown({
  //     resume: activeResume,
  //     title,
  //     onStart: () => setIsExportingMarkdown(true),
  //     onEnd: () => setIsExportingMarkdown(false),
  //     successMessage: t("toast.markdownSuccess"),
  //     errorMessage: t("toast.markdownError"),
  //     markdownOptions: {
  //       basicFieldLabels: {
  //         name: tBasicField("name"),
  //         title: tBasicField("title"),
  //         employementStatus: tBasicField("employementStatus"),
  //         birthDate: tBasicField("birthDate"),
  //         email: tBasicField("email"),
  //         phone: tBasicField("phone"),
  //         location: tBasicField("location")
  //       }
  //     }
  //   });
  // };

  const handlePrint = async () => {
    const resumeContent = document.getElementById("resume-preview");
    if (!resumeContent) {
      console.error("Resume content not found");
      return;
    }

    try {
      setIsPrinting(true);
      const pagePadding = globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING;
      await exportResumeToBrowserPrint(
        resumeContent,
        pagePadding,
        globalSettings?.fontFamily
      );
    } finally {
      setIsPrinting(false);
    }
  };

  const loadingText = isBusy ? t("button.exporting") : "";
  const exportDisplayPhase = getPdfExportDisplayPhase(exportState.phase);
  const exportTrigger = children
    ? React.isValidElement(children)
      ? React.cloneElement(
          children as React.ReactElement<{
            disabled?: boolean;
            "aria-busy"?: boolean;
          }>,
          {
            disabled: isBusy,
            "aria-busy": isBusy,
          }
        )
      : children
    : (
        <Button
          className="h-9 px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 transition-all hover:shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={isBusy}
          aria-busy={isBusy}
        >
          {isBusy ? (
            <>
              <Loader2 className="w-4 h-4 motion-safe:animate-spin" />
              <span>{loadingText}</span>
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              <span>{t("button.export")}</span>
              <ChevronDown className="w-3.5 h-3.5 opacity-60 ml-0.5" />
            </>
          )}
        </Button>
      );

  return (
    <Dialog
      open={exportState.isOpen}
      onOpenChange={(open) => {
        if (isBusy) return;
        dispatchExportState({ type: open ? "open" : "close" });
      }}
    >
      <DialogTrigger asChild>
        {exportTrigger}
      </DialogTrigger>

      <DialogContent
        hideClose={isBusy}
        aria-busy={isBusy}
        className="w-[calc(100%-2rem)] max-w-[760px] gap-0 overflow-hidden rounded-2xl border border-border/70 bg-background p-0 shadow-[0_24px_80px_-32px_rgba(0,0,0,0.28)]"
      >
        <div className="border-b border-border/60 px-7 py-6">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {t("modal.title")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t("modal.subtitle")}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div
          className="relative px-7 pb-7 pt-6"
          style={{
            minHeight: `${PDF_EXPORT_LAYOUTS[isExporting ? "progress" : "chooser"].bodyHeight}px`,
          }}
        >
          <div
            className={cn(
              "flex h-full flex-col justify-between",
              isExporting && "pointer-events-none opacity-35"
            )}
            aria-hidden={isExporting}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ExportOption
                icon={FileText}
                eyebrow="PDF"
                title={t("button.exportPdf")}
                description={t("modal.pdfDesc")}
                isLoading={isExporting}
                onClick={handleExport}
                featured
              />
              <ExportOption
                icon={Printer}
                eyebrow="LOCAL"
                title={t("button.print")}
                description={t("modal.printDesc")}
                isLoading={isPrinting}
                onClick={handlePrint}
              />
            </div>

            <div className="mt-5 flex items-start gap-2.5 border-t border-border/60 pt-4 text-[11px] leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p>{t("modal.privacyNotice")}</p>
            </div>
          </div>

          {isExporting && (
            <div
              className="absolute inset-0 z-10 flex items-center px-7 pb-7 pt-6"
              role="status"
              aria-live="polite"
            >
              <div className="flex h-full w-full flex-col justify-center rounded-xl border border-border bg-card px-6 py-5">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[15px] font-semibold tracking-tight">
                        {exportDisplayPhase === "downloading"
                          ? t("modal.exporting.downloadingTitle")
                          : t("modal.exporting.title")}
                      </h3>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        PDF
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                      {exportDisplayPhase === "downloading"
                        ? t("modal.exporting.downloadingDescription")
                        : t("modal.exporting.description")}
                    </p>
                  </div>
                </div>

                <div className="mt-6" aria-hidden="true">
                  <div
                    className="h-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={t("modal.exporting.progressLabel")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    data-progress-mode={PDF_EXPORT_PROGRESS.mode}
                  >
                    <div className="pdf-export-indeterminate h-full rounded-full bg-foreground" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PdfExport;
