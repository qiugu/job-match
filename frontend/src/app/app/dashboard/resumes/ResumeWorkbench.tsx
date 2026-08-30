import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslations, useLocale } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { CreateResumeModal } from "./CreateResumeModal";
import { ImportResumeDialog } from "./ImportResumeDialog";
import { ResumeCardItem } from "./ResumeCardItem";
import { AnimatedImportButton } from "./AnimatedImportButton";
import {
    extractJsonContent,
    createResumeFromAIResult,
    toStringArray
} from "./utils";

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
        syncResumeToBackend,
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
    const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const pdfFileInputRef = useRef<HTMLInputElement>(null);

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
        const formData = new FormData();
        formData.append("file", file);
        formData.append("locale", locale);

        const response = await fetch("/api/resume-import-pdf", {
            method: "POST",
            body: formData,
        });

        const data = await response.json();
        if (!response.ok) {
            const message = data?.details
                ? `${data?.error || "Resume import failed"}\n${data.details}`
                : data?.error || "Resume import failed";
            throw new Error(message);
        }

        const aiResume = data?.resume
            ? data.resume
            : data?.choices?.[0]?.message?.content
                ? extractJsonContent(data.choices[0].message.content)
                : null;

        if (!aiResume) {
            throw new Error("Invalid AI response");
        }

        const nameWithoutExt = file.name.replace(/\.[^.]+$/, "").trim();
        const resume = createResumeFromAIResult(aiResume, nameWithoutExt);
        const resumeId = addResume(resume);
        setActiveResume(resumeId);
        // 导入即落库：把这份简历写入后端 master_resumes，保证「我的简历」与
        // 「优化简历」下拉同源一致（不再依赖后续进入匹配页时兜底补同步）。
        await syncResumeToBackend(resumeId).catch((err) => {
            console.error("导入简历落库失败:", err);
            // 标题（文件名）重复时后端返回 409，必须让用户看见：否则本地有简历、
            // 数据库没有，重新进入列表会被后端数据覆盖掉。
            toast.error(`已导入，但保存到数据库失败：${(err as Error).message}`);
        });
        setIsImportDialogOpen(false);
        toast.success(t("dashboard.resumes.importDialog.pdfSuccess"));
        router.push({ to: "/app/workbench/$id", params: { id: resumeId } });
    };

    const handlePdfFileChange = async (
        event: React.ChangeEvent<HTMLInputElement>
    ) => {
        const file = event.target.files?.[0];
        event.target.value = "";
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
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="flex-1 space-y-6 py-8"
            >
                <motion.div
                    className="px-4 sm:px-6 flex items-center justify-between"
                    initial={{ y: -20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.3 }}
                >
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
                        {t("dashboard.resumes.myResume")}
                    </h1>
                    <div className="flex items-center space-x-2">
                        <AnimatedImportButton onClick={() => setIsImportDialogOpen(true)} t={t} />
                    </div>
                </motion.div>

                <motion.div
                    className="flex-1 w-full p-3 sm:p-6"
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.3, delay: 0.2 }}
                >
                    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-6">
                        <motion.div
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            transition={{ type: "spring", stiffness: 400, damping: 17 }}
                            onClick={() => setIsCreateModalOpen(true)}
                        >
                            <Card
                                className={cn(
                                    "relative border border-dashed cursor-pointer transition-all duration-200 aspect-[210/297] flex flex-col",
                                    "hover:border-gray-400 hover:bg-gray-50",
                                    "dark:hover:border-primary dark:hover:bg-primary/10"
                                )}
                            >
                                <CardContent className="flex-1 p-0 text-center flex flex-col items-center justify-center">
                                    <motion.div
                                        className="mb-4 p-4 rounded-full bg-gray-100 dark:bg-primary/10"
                                        whileHover={{ rotate: 90 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <Plus className="h-8 w-8 text-gray-600 dark:text-primary" />
                                    </motion.div>
                                    <CardTitle className="text-xl text-gray-900 dark:text-gray-100 px-4">
                                        {t("dashboard.resumes.newResume")}
                                    </CardTitle>
                                    <CardDescription className="mt-2 text-gray-600 dark:text-gray-400 px-4">
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
                </motion.div>

                <CreateResumeModal
                    open={isCreateModalOpen}
                    onOpenChange={setIsCreateModalOpen}
                    onCreate={handleCreateFromModal}
                />

                <ImportResumeDialog
                    open={isImportDialogOpen}
                    isImporting={isImporting}
                    onOpenChange={setIsImportDialogOpen}
                    pdfFileInputRef={pdfFileInputRef}
                    onPdfFileChange={handlePdfFileChange}
                />
            </motion.div>
        </ScrollArea>
    );
};
