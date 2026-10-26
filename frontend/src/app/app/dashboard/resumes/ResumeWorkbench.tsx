import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations, useLocale } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { toast } from "sonner";
import {
    IconPlus,
    IconUpload,
} from "@/components/shared/icons/XaiIcons";
import {
    Card,
    CardContent,
    CardDescription,
    CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { preloadFontFamily } from "@/utils/fonts";
import { useResumeStore } from "@/store/useResumeStore";
import {
    MARKDOWN_TEMPLATES,
    getMarkdownTemplateContent,
} from "@/config";
import { uploadMasterResume } from "@/lib/jobmatch";
import { CreateResumeModal } from "./CreateResumeModal";
import { ResumeCardItem } from "./ResumeCardItem";

export const ResumeWorkbench = () => {
    const t = useTranslations();
    const locale = useLocale();
    const {
        resumes,
        setActiveResume,
        addResume,
        deleteResume,
        createResume,
        loadResumesFromBackend,
    } = useResumeStore();

    // 「我的简历」页统一读后端 master_resumes：进入时从后端拉取全部简历填充内存，
    // 与匹配页下拉同源，保证两列表一致。内存中未落库的草稿不受影响。
    useEffect(() => {
        loadResumesFromBackend().catch((err: unknown) =>
            console.error("从后端加载简历失败:", err)
        );
    }, [loadResumesFromBackend]);
    const router = useRouter();
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    // 页头「上传 PDF 简历」与新建弹窗内的 PDF 导入共用 handleImportFile
    const pdfInputRef = React.useRef<HTMLInputElement>(null);

    useEffect(() => {
        const fontFamilies = Array.from(
            new Set(
                Object.values(resumes)
                    .map((resume) => resume.globalSettings?.fontFamily)
                    .filter(Boolean)
            )
        );

        if (fontFamilies.length === 0) return;

        let cancelled = false;
        const warmFonts = () => {
            if (cancelled) return;
            fontFamilies.forEach((fontFamily) => {
                preloadFontFamily(fontFamily).catch((error) => {
                    console.warn("Failed to preload resume font:", error);
                });
            });
        };

        const supportsIdleCallback =
            typeof window !== "undefined" &&
            typeof window.requestIdleCallback === "function";
        const idleCallback = supportsIdleCallback
            ? window.requestIdleCallback(warmFonts, { timeout: 2500 })
            : globalThis.setTimeout(warmFonts, 1000);

        return () => {
            cancelled = true;
            if (
                supportsIdleCallback &&
                typeof window !== "undefined" &&
                typeof window.cancelIdleCallback === "function"
            ) {
                window.cancelIdleCallback(idleCallback as number);
            } else {
                globalThis.clearTimeout(idleCallback);
            }
        };
    }, [resumes]);

    const handleCreateFromModal = async (templateId: string | null) => {
        const isBlank = !templateId;
        const newId = await createResume(templateId, isBlank);

        if (templateId) {
            const template = MARKDOWN_TEMPLATES.find((t) => t.id === templateId);
            if (template) {
                const { resumes, updateResume } = useResumeStore.getState();
                const resume = resumes[newId];
                if (resume) {
                    updateResume(newId, {
                        templateId: template.id,
                        markdownContent: getMarkdownTemplateContent(template, locale),
                        globalSettings: {
                            ...resume.globalSettings,
                            ...template.globalSettings,
                        },
                    });
                }
            }
        }

        setIsCreateModalOpen(false);
        setActiveResume(newId);
        router.push({ to: "/app/workbench/$id", params: { id: newId } });
    };

    const duplicateResume = async (resume: any) => {
        const { generateUUID } = await import("@/utils/uuid");
        const now = new Date().toISOString();

        const { id, ...rest } = resume;
        const newResume = {
            ...rest,
            id: generateUUID(),
            title: `${resume.title || t("dashboard.resumes.untitled")} - ${t("common.copy")}`,
            createdAt: now,
            updatedAt: now,
        };

        const resumeId = addResume(newResume);
        toast.success(t("previewDock.copyResume.success"));
    };

    const importResumeFromPdf = async (file: File) => {
        // PDF 导入走 resume.py 的确定性上传落库（POST /api/master-resumes）：
        // 后端用 pypdf/pymupdf 重建层级 Markdown 骨架（无 LLM），直接写入
        // master_resumes 并返回真实记录 id 与 markdownContent。前端以 blank
        // 简历为基底、把 markdownContent 写入编辑器，得到可编辑的 markdown 简历。
        try {
            await uploadMasterResume(file);
        } catch (err) {
            // 标题（文件名）重复时后端返回 409，必须让用户看见：否则本地无简历、
            // 数据库已有同名记录，重新进入列表会被后端数据覆盖掉。
            console.error("PDF 简历导入失败:", err);
            toast.error(`导入失败：${(err as Error).message}`);
            setIsCreateModalOpen(false);
            return;
        }

        // 上传成功后回到列表页（而非自动进入编辑器）：关闭弹框并从后端
        // 重新拉取「我的简历」列表，确保新导入的简历及时出现在列表中。
        setIsCreateModalOpen(false);
        toast.success(t("dashboard.resumes.importDialog.pdfSuccess"));
        loadResumesFromBackend().catch((err: unknown) =>
            console.error("从后端刷新简历列表失败:", err)
        );
    };

    const handleImportFile = async (file: File) => {
        if (!file || isImporting) return;

        try {
            setIsImporting(true);
            await importResumeFromPdf(file);
        } catch (error) {
            console.error("Import PDF error:", error);
            const message =
                error instanceof Error && error.message
                    ? error.message
                    : t("dashboard.resumes.importDialog.pdfError");
            toast.error(message);
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <ScrollArea className="h-[calc(100vh-2rem)] w-full">
            <div className="workbench-page flex-1 space-y-7 py-9">
                <div className="workbench-header flex flex-col gap-4 border-b px-6 pb-6 sm:flex-row sm:items-end sm:justify-between">
                    <div className="flex flex-col gap-2.5">
                        <p className="xai-eyebrow">MY RESUMES — MARKDOWN</p>
                        <h1 className="text-[32px] font-medium leading-none tracking-tight text-xai-text">
                            {t("dashboard.resumes.myResume")}
                        </h1>
                        <p className="text-[13px] text-xai-mute">
                            {t("dashboard.resumes.resumesSubtitle")}
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                        <button
                            type="button"
                            className="xai-pill-outline"
                            disabled={isImporting}
                            onClick={() => pdfInputRef.current?.click()}
                        >
                            <IconUpload size={16} />
                            {isImporting
                                ? t("dashboard.resumes.importDialog.importing")
                                : t("dashboard.resumes.uploadPdf")}
                        </button>
                        <button
                            type="button"
                            className="xai-pill-primary"
                            onClick={() => setIsCreateModalOpen(true)}
                        >
                            <IconPlus size={16} />
                            {t("dashboard.resumes.newResume")}
                        </button>
                    </div>
                </div>

                <div className="w-full flex-1 px-6">
                    <div className="grid grid-cols-2 gap-5 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                        <motion.div
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            transition={{ type: "spring", stiffness: 400, damping: 17 }}
                            onClick={() => setIsCreateModalOpen(true)}
                        >
                            <Card
                                className={cn(
                                    "relative flex aspect-[210/297] cursor-pointer flex-col rounded-[10px] border border-dashed border-[#3d4048] bg-transparent shadow-none transition-colors duration-200",
                                    "hover:border-white/60 hover:bg-xai-surface/60"
                                )}
                            >
                                <CardContent className="flex flex-1 flex-col items-center justify-center p-0 text-center">
                                    <motion.div
                                        className="mb-4 flex size-14 items-center justify-center rounded-full border border-xai-hairline bg-xai-surface-2 text-xai-mute"
                                        whileHover={{ rotate: 90 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <IconPlus size={24} />
                                    </motion.div>
                                    <CardTitle className="px-4 text-[17px] font-medium text-xai-text">
                                        {t("dashboard.resumes.newResume")}
                                    </CardTitle>
                                    <CardDescription className="mt-2 px-6 text-[12px] text-xai-mute">
                                        {t("dashboard.resumes.newResumeDescription")}
                                    </CardDescription>
                                </CardContent>
                            </Card>
                        </motion.div>

                        <AnimatePresence>
                            {Object.entries(resumes)
                                .sort(([, a], [, b]) => {
                                    const dateA = new Date(a.createdAt || 0).getTime();
                                    const dateB = new Date(b.createdAt || 0).getTime();
                                    return dateB - dateA;
                                })
                                .map(([id, resume], index) => (
                                    <ResumeCardItem
                                        key={id}
                                        id={id}
                                        resume={resume}
                                        t={t}
                                        locale={locale}
                                        router={router}
                                        deleteResume={deleteResume}
                                        duplicateResume={duplicateResume}
                                        index={index}
                                    />
                                ))}
                        </AnimatePresence>
                    </div>
                </div>

                <CreateResumeModal
                    open={isCreateModalOpen}
                    onOpenChange={setIsCreateModalOpen}
                    onCreate={handleCreateFromModal}
                    onImportPdf={handleImportFile}
                    isImporting={isImporting}
                />

                {/* 页头「上传 PDF 简历」的隐藏文件选择器，与弹窗内导入共用 handleImportFile */}
                <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void handleImportFile(file);
                    }}
                />
            </div>
        </ScrollArea>
    );
};
