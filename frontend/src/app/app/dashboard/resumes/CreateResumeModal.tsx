import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    MARKDOWN_TEMPLATES,
    buildMarkdownTemplateResume,
    getMarkdownTemplateContent,
    type MarkdownTemplate,
} from "@/config";
import { useResumeStore } from "@/store/useResumeStore";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import type { Translator } from "@/i18n/compat/utils";
import { Loader2 } from "lucide-react";
import {
    IconChevronRight,
    IconPlus,
    IconX,
} from "@/components/shared/icons/XaiIcons";
import { PdfIcon } from "@/components/shared/icons/PdfIcon";
import { cn } from "@/lib/utils";

const A4_WIDTH_PX = 793.700787;
const A4_HEIGHT_PX = 1122.519685;

type BlankTemplate = {
    id: null;
    isBlank: true;
    nameKey: "blankTitle";
};

type NormalTemplate = MarkdownTemplate & { isBlank: false; nameKey: string };
type TemplateOption = NormalTemplate | BlankTemplate;

const BLANK_TEMPLATE: BlankTemplate = { id: null, isBlank: true, nameKey: "blankTitle" };
const NORMAL_TEMPLATES: NormalTemplate[] = MARKDOWN_TEMPLATES.map((template) => ({
    ...template,
    isBlank: false,
    nameKey: template.nameKey,
}));

const BlankTemplateThumbnail = ({ t }: { t: Translator }) => (
    <div className="flex h-full w-full flex-col items-center justify-center bg-xai-surface-2">
        <div className="mb-6 flex size-20 items-center justify-center rounded-full border border-xai-hairline bg-xai-surface text-xai-mute transition-colors group-hover:text-xai-text">
            <IconPlus size={32} />
        </div>
        <span className="text-[17px] font-medium text-xai-text-mid transition-colors group-hover:text-xai-text">
            {t("dashboard.resumes.createDialog.blankTitle")}
        </span>
        <p className="mt-2.5 px-8 text-center text-[12px] leading-relaxed text-xai-mute">
            {t("dashboard.resumes.createDialog.blankThumbnailDescription")}
        </p>
    </div>
);

interface MarkdownThumbnailProps {
    template: MarkdownTemplate;
    scaleModifier?: number;
}

const MarkdownThumbnail = ({
    template,
    scaleModifier = 1,
}: MarkdownThumbnailProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(0.2);
    const locale = useLocale();

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            const { width } = entries[0].contentRect;
            if (width > 0) {
                setScale((width / A4_WIDTH_PX) * scaleModifier);
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [scaleModifier]);

    const previewResume = buildMarkdownTemplateResume(template, locale, "");

    return (
        <div className="w-full h-full overflow-hidden bg-white flex items-center justify-center" ref={containerRef}>
            <div
                style={{
                    width: scale * A4_WIDTH_PX,
                    height: scale * A4_HEIGHT_PX,
                }}
                className="flex-shrink-0"
            >
                <div
                    className="bg-white origin-top-left pointer-events-none"
                    style={{
                        width: "210mm",
                        height: "297mm",
                        transform: `scale(${scale})`,
                    }}
                >
                    <MarkdownPreview
                        embedded
                        markdown={getMarkdownTemplateContent(template, locale)}
                        resume={previewResume}
                    />
                </div>
            </div>
        </div>
    );
};

const TemplateCardThumbnail = ({
    template,
    t,
}: {
    template: TemplateOption;
    t: Translator;
}) => {
    if (template.isBlank) {
        return <BlankTemplateThumbnail t={t} />;
    }

    return <MarkdownThumbnail template={template} />;
};

interface CreateResumeModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (templateId: string | null) => void;
    onImportPdf: (file: File) => void;
    isImporting: boolean;
}

export const CreateResumeModal = ({
    open,
    onOpenChange,
    onCreate,
    onImportPdf,
    isImporting,
}: CreateResumeModalProps) => {
    const t = useTranslations();
    const locale = useLocale();
    const [previewTarget, setPreviewTarget] = useState<TemplateOption | null>(null);
    const pdfFileInputRef = useRef<HTMLInputElement>(null);

    const handleCreate = (template: TemplateOption) => {
        if (isImporting) return;
        onCreate(template.id);
        setPreviewTarget(null);
    };

    const handlePdfFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || isImporting) return;
        onImportPdf(file);
    };

    // Close preview when dialog closes
    useEffect(() => {
        if (!open) {
            const timeoutId = window.setTimeout(() => setPreviewTarget(null), 300);
            return () => window.clearTimeout(timeoutId);
        }
    }, [open]);

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (isImporting) return;
                onOpenChange(nextOpen);
            }}
        >
            <DialogContent hideClose className="flex h-[88vh] max-w-[1050px] w-[95vw] flex-col overflow-hidden rounded-2xl border border-xai-hairline bg-xai-surface p-0 shadow-none">
                {/* We keep an empty DialogTitle to satisfy accessibility requirements without taking up space */}
                <DialogTitle className="sr-only">{t("dashboard.resumes.createDialog.title")}</DialogTitle>

                <div className="relative w-full h-full min-h-0 flex flex-col">
                    {/* Hidden PDF file picker for the import card */}
                    <input
                        ref={pdfFileInputRef}
                        type="file"
                        accept=".pdf,application/pdf"
                        className="hidden"
                        disabled={isImporting}
                        onChange={handlePdfFileChange}
                    />
                    {/* HEADER BAR */}
                    <div className="z-10 flex flex-none items-center justify-between border-b border-xai-hairline px-7 py-5">
                        <div className="flex flex-col gap-1.5">
                            <p className="xai-eyebrow">NEW RESUME</p>
                            <div className="text-[22px] font-medium tracking-tight text-xai-text">
                                {t("dashboard.resumes.createDialog.title")}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => onOpenChange(false)}
                            disabled={isImporting}
                            aria-label={t("common.cancel")}
                            className="-mr-1.5 rounded-full p-2 text-xai-mute transition-colors hover:bg-xai-surface-2 hover:text-xai-text disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <IconX size={20} />
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 relative w-full">
                        <ScrollArea className="h-full w-full">
                            <div className="px-8 pb-12 max-w-7xl mx-auto space-y-12">
                                {/* SECTION 1: CREATE ENTRY — BLANK OR IMPORT PDF */}
                                <section>
                                    <div className="mb-5 flex items-center">
                                        <h4 className="font-mono text-[11px] font-normal uppercase tracking-[0.08em] text-xai-eyebrow">
                                            {t("dashboard.resumes.createDialog.startCreate")}
                                        </h4>
                                        <div className="ml-5 h-px flex-1 bg-xai-hairline" />
                                    </div>
                                    <div className={cn("grid gap-6 lg:grid-cols-2", isImporting && "pointer-events-none")}>
                                        {/* BLANK RESUME CARD */}
                                        <motion.div
                                            layoutId={`card-container-blank`}
                                            whileHover={{ y: -4, scale: 1.01 }}
                                            whileTap={{ scale: 0.99 }}
                                            role="button"
                                            tabIndex={0}
                                            aria-disabled={isImporting}
                                            onClick={() => handleCreate(BLANK_TEMPLATE)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    handleCreate(BLANK_TEMPLATE);
                                                }
                                            }}
                                            className={cn(
                                                "group flex cursor-pointer flex-col items-center gap-6 rounded-[10px] border border-xai-hairline bg-xai-surface-2 p-6 transition-colors duration-200 hover:border-white/50 sm:flex-row",
                                                isImporting && "opacity-60"
                                            )}
                                        >
                                            {/* Small visual icon area */}
                                            <motion.div
                                                layoutId={`card-image-blank`}
                                                className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-[10px] border border-xai-hairline bg-xai-surface text-xai-mute transition-colors group-hover:text-xai-text"
                                            >
                                                <IconPlus size={26} />
                                            </motion.div>

                                            <div className="flex-1 text-center sm:text-left">
                                                <motion.div layoutId={`card-title-blank`} className="inline-block">
                                                    <h5 className="mb-1.5 text-[16px] font-medium text-xai-text">
                                                        {t("dashboard.resumes.createDialog.blankTitle")}
                                                    </h5>
                                                </motion.div>
                                                <p className="max-w-lg text-[12.5px] leading-relaxed text-xai-mute">
                                                    {t("dashboard.resumes.createDialog.blankCardDescription")}
                                                </p>
                                            </div>

                                            <div className="hidden items-center gap-1 text-[12px] text-xai-mute sm:flex">
                                                {t("dashboard.resumes.createDialog.createNow")} <IconChevronRight size={14} />
                                            </div>
                                        </motion.div>

                                        {/* IMPORT PDF CARD */}
                                        <motion.div
                                            role="button"
                                            tabIndex={0}
                                            aria-disabled={isImporting}
                                            whileHover={isImporting ? undefined : { y: -4, scale: 1.01 }}
                                            whileTap={isImporting ? undefined : { scale: 0.99 }}
                                            onClick={() => pdfFileInputRef.current?.click()}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    pdfFileInputRef.current?.click();
                                                }
                                            }}
                                            className={cn(
                                                "group flex cursor-pointer flex-col items-center gap-6 rounded-[10px] border border-xai-hairline bg-xai-surface-2 p-6 transition-colors duration-200 hover:border-white/50 sm:flex-row",
                                                isImporting && "cursor-not-allowed opacity-60"
                                            )}
                                        >
                                            <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-[10px] border border-xai-hairline bg-xai-surface">
                                                <PdfIcon className="h-9 w-9" />
                                            </div>

                                            <div className="flex-1 text-center sm:text-left">
                                                <h5 className="mb-1.5 text-[16px] font-medium text-xai-text">
                                                    {t("dashboard.resumes.createDialog.importTitle")}
                                                </h5>
                                                <p className="max-w-lg text-[12.5px] leading-relaxed text-xai-mute">
                                                    {t("dashboard.resumes.createDialog.importDescription")}
                                                </p>
                                            </div>

                                            <div className="hidden items-center gap-1 whitespace-nowrap text-[12px] text-xai-mute sm:flex">
                                                {isImporting ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <>
                                                        {t("dashboard.resumes.createDialog.importCta")}
                                                        <IconChevronRight size={14} />
                                                    </>
                                                )}
                                            </div>
                                        </motion.div>
                                    </div>
                                </section>

                                {/* SECTION 2: NORMAL TEMPLATES */}
                                <section>
                                    <div className="mb-5 flex items-center">
                                        <h4 className="font-mono text-[11px] font-normal uppercase tracking-[0.08em] text-xai-eyebrow">
                                            {t("dashboard.resumes.createDialog.startFromTemplate")}
                                        </h4>
                                        <div className="ml-5 h-px flex-1 bg-xai-hairline" />
                                    </div>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 sm:gap-8 hover:!shadow-none">
                                        {NORMAL_TEMPLATES.map((template) => {
                                            const templateName = t(`dashboard.templates.${template.nameKey}.name`);

                                            return (
                                                <motion.div
                                                    key={template.id}
                                                    layoutId={`card-container-${template.id}`}
                                                    whileHover={{ y: 0, scale: 1.02 }}
                                                    whileTap={{ scale: 0.98 }}
                                                    onClick={() => setPreviewTarget(template)}
                                                    className="group cursor-pointer flex flex-col"
                                                >
                                                    {/* The Thumbnail Card */}
                                                    <motion.div
                                                        layoutId={`card-image-${template.id}`}
                                                        className="relative aspect-[210/297] overflow-hidden rounded-[10px] border border-xai-hairline bg-white shadow-none transition-colors duration-300 group-hover:border-xai-text/60"
                                                    >
                                                        <TemplateCardThumbnail
                                                            template={template}
                                                            t={t}
                                                        />
                                                        <div className="pointer-events-none absolute inset-0 rounded-[10px] ring-1 ring-inset ring-black/10" />
                                                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                                                    </motion.div>

                                                    {/* Minimalist Title below */}
                                                    <motion.div
                                                        layoutId={`card-title-${template.id}`}
                                                        className="mt-4 flex items-center justify-center"
                                                    >
                                                        <span className="text-[13px] font-medium text-xai-mute transition-colors group-hover:text-xai-text">
                                                            {templateName}
                                                        </span>
                                                    </motion.div>
                                                </motion.div>
                                            )
                                        })}
                                    </div>
                                </section>
                            </div>
                        </ScrollArea>
                    </div>

                    {/* OVERLAY LARGE PREVIEW (Shared Layout Animation) */}
                    <AnimatePresence>
                        {previewTarget && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.3, ease: "easeInOut" }}
                                className="fixed inset-0 z-50 flex flex-col overflow-hidden rounded-2xl bg-xai-canvas sm:flex-row"
                            >
                                {/* Left: Huge Preview Area */}
                                <div className="relative flex h-full flex-1 flex-col items-center justify-center overflow-hidden bg-xai-canvas p-8 sm:p-12">
                                    <div className="absolute left-0 top-0 z-20 flex w-full justify-start p-6">
                                        <button
                                            type="button"
                                            onClick={() => setPreviewTarget(null)}
                                            className="rounded-full p-2 text-xai-mute transition-colors hover:bg-xai-surface-2 hover:text-xai-text"
                                            aria-label={t("dashboard.resumes.createDialog.backToGrid")}
                                        >
                                            <IconChevronRight size={20} className="rotate-180" />
                                        </button>
                                    </div>

                                    <motion.div
                                        layoutId={`card-container-${previewTarget.id || 'blank'}`}
                                        className="w-full flex-1 flex flex-col items-center justify-center p-2 min-h-0"
                                    >
                                        <motion.div
                                            layoutId={`card-image-${previewTarget.id || 'blank'}`}
                                            className="aspect-[210/297] overflow-hidden rounded-[10px] bg-white ring-1 ring-black/10"
                                            style={{
                                                maxHeight: "100%",
                                                maxWidth: "100%",
                                                height: "100%",
                                                width: "auto"
                                            }}
                                        >
                                            {previewTarget.isBlank ? (
                                                <BlankTemplateThumbnail t={t} />
                                            ) : (
                                                <MarkdownThumbnail template={previewTarget} scaleModifier={1} />
                                            )}
                                        </motion.div>
                                    </motion.div>
                                </div>

                                {/* Right: Info Sidebar */}
                                <div className="relative z-10 flex h-full w-full flex-col border-l border-xai-hairline bg-xai-surface sm:w-[380px]">
                                    <div className="flex flex-1 flex-col justify-center p-10">
                                        <motion.div
                                            layoutId={`card-title-${previewTarget.id || 'blank'}`}
                                            className="inline-block"
                                        >
                                            <h3 className="mb-4 text-[30px] font-medium tracking-tight text-xai-text">
                                                {previewTarget.isBlank
                                                    ? t("dashboard.resumes.createDialog.blankTitle")
                                                    : t(`dashboard.templates.${previewTarget.nameKey}.name`)}
                                            </h3>
                                        </motion.div>

                                        <div className="mb-6 h-px w-12 bg-xai-hairline" />

                                        <p className="mb-10 text-[14px] leading-relaxed text-xai-mute">
                                            {previewTarget.isBlank
                                                ? t("dashboard.resumes.createDialog.blankPreviewDescription")
                                                : t(`dashboard.templates.${previewTarget.nameKey}.description`)}
                                        </p>

                                        <button
                                            type="button"
                                            className="xai-pill-primary w-full"
                                            onClick={() => handleCreate(previewTarget)}
                                        >
                                            {t("dashboard.resumes.createDialog.useThisTemplate")}
                                        </button>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </DialogContent>
        </Dialog>
    );
};
