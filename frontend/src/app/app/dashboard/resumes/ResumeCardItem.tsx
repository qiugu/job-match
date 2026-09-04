import React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
    Card,
    CardContent,
    CardFooter,
} from "@/components/ui/card";
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
import ResumeTemplateComponent from "@/components/templates";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { cn } from "@/lib/utils";
import { normalizeFontFamily } from "@/utils/fonts";
import { IconCopy, IconPen, IconTrash } from "@/components/shared/icons/XaiIcons";

interface ResumeCardItemProps {
    id: string;
    resume: any;
    t: any;
    locale: string;
    router: any;
    deleteResume: (resume: any) => void;
    duplicateResume: (resume: any) => void;
    index: number;
}

export const ResumeCardItem = ({
    id,
    resume,
    t,
    locale,
    router,
    deleteResume,
    duplicateResume,
    index,
}: ResumeCardItemProps) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [scale, setScale] = React.useState(0.24);
    const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);

    const activeTemplate =
        DEFAULT_TEMPLATES.find((template) => template.id === resume.templateId) ??
        DEFAULT_TEMPLATES[0];
    const templateNameKey =
        activeTemplate.id === "left-right" ? "leftRight" : activeTemplate.id;

    // 缩略图主题色取自简历自身的 globalSettings.themeColor。
    // 列表页卡片的 MarkdownPreview 内部 themeColor 仅作用于标题/下划线，
    // 在 scale(0.24) 缩放下视觉上几乎不可见，会被误判为「同色」；
    // 这里在缩略图顶部加一条 5px 的主题色色带，让「每份简历的主题色」
    // 在缩略图里一眼可辨，且保证取的是简历自身设置的主题色。
    const cardThemeColor = resume.globalSettings?.themeColor || "#000000";

    React.useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            const { width } = entries[0].contentRect;
            if (width > 0) {
                setScale(width / 793.700787); // Exact 210mm in pixels at 96dpi
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{
                duration: 0.3,
                delay: index * 0.1,
            }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
        >
            <Card
                className={cn(
                    "group flex aspect-[210/297] flex-col overflow-hidden rounded-[10px] border-xai-hairline bg-xai-surface shadow-none transition-colors duration-200",
                    "hover:border-[#3d4048]"
                )}
            >
                <CardContent
                    className="relative flex-1 cursor-pointer overflow-hidden bg-white p-0"
                    onClick={(e) => {
                        e.stopPropagation();
                        router.push({ to: "/app/workbench/$id", params: { id } });
                    }}
                >
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden pb-6 transition-transform duration-300 group-hover:scale-[1.02]" ref={containerRef}>
                        <div className="relative h-full w-full origin-top bg-white">
                            {/* 顶部主题色色带：直接显示该简历自身的主题色，
                                缩略图里一眼可辨，缩放与压缩都不影响颜色识别。 */}
                            <div
                                aria-hidden
                                className="absolute inset-x-0 top-0 z-10"
                                style={{
                                    height: "5px",
                                    backgroundColor: cardThemeColor,
                                }}
                            />
                            {/* 页边距由 MarkdownPreview 的纸张统一提供（每页上下左右都有），
                                这里不能再叠一层 padding，否则缩略图内容被挤窄、与编辑器预览换行不一致。 */}
                            <div
                                className="resume-preview absolute left-0 top-0 bg-white"
                                style={{
                                    width: "210mm",
                                    height: "297mm",
                                    transform: `scale(${scale})`,
                                    transformOrigin: "top left",
                                    fontFamily: normalizeFontFamily(resume.globalSettings?.fontFamily),
                                }}
                            >
                                {resume.markdownContent && resume.markdownContent.trim() ? (
                                    <div className="h-full w-full overflow-hidden bg-white">
                                        <MarkdownPreview embedded markdown={resume.markdownContent} resume={resume} />
                                    </div>
                                ) : (
                                    <ResumeTemplateComponent data={resume as any} template={activeTemplate} />
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 底部信息条：从卡片深色渐隐，让标题浮在缩略图之上 */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[60%] z-0 bg-gradient-to-t from-xai-surface via-xai-surface/90 to-transparent"></div>
                    <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between px-4 pb-3 pt-12 transition-colors group-hover:bg-xai-surface/60">
                        <div className="flex w-full flex-col">
                            <span className="w-[90%] truncate text-[15px] font-medium text-white drop-shadow-sm">
                                {resume.title || t("dashboard.resumes.untitled")}
                            </span>
                            <span className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-xai-mute">
                                {t(`dashboard.templates.${templateNameKey}.name`)}
                                {resume.createdAt
                                    ? (() => {
                                          try {
                                              return ` · ${new Intl.DateTimeFormat(locale, {
                                                  year: 'numeric',
                                                  month: 'short',
                                                  day: 'numeric',
                                                  hour: '2-digit',
                                                  minute: '2-digit',
                                                  hour12: false
                                              }).format(new Date(resume.createdAt))}`;
                                          } catch {
                                              return "";
                                          }
                                      })()
                                    : ""}
                            </span>
                        </div>
                    </div>
                </CardContent>
                <CardFooter className="overflow-hidden border-t border-xai-hairline bg-xai-canvas/40 p-0">
                    <div className="flex h-11 w-full divide-x divide-xai-hairline">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                router.push({ to: "/app/workbench/$id", params: { id } });
                            }}
                            className="group flex flex-1 items-center justify-center gap-1.5 text-[13px] font-medium text-xai-mute transition-colors duration-200 hover:bg-xai-surface-2 hover:text-white"
                        >
                            <IconPen size={14} className="transition-transform duration-200 group-hover:scale-110" />
                            <span>{t("common.edit")}</span>
                        </button>

                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                duplicateResume(resume);
                            }}
                            className="group flex flex-1 items-center justify-center gap-1.5 text-[13px] font-medium text-xai-mute transition-colors duration-200 hover:bg-xai-surface-2 hover:text-white"
                        >
                            <IconCopy size={14} className="transition-transform duration-200 group-hover:scale-110" />
                            <span>{t("common.copy")}</span>
                        </button>

                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowDeleteDialog(true);
                            }}
                            className="group flex flex-1 items-center justify-center gap-1.5 text-[13px] font-medium text-[#8a8f98] transition-colors duration-200 hover:bg-[#221312] hover:text-xai-del"
                        >
                            <IconTrash size={14} className="transition-transform duration-200 group-hover:scale-110" />
                            <span>{t("common.delete")}</span>
                        </button>
                    </div>
                </CardFooter>
            </Card>

            <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("dashboard.resumes.deleteConfirmTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t("dashboard.resumes.deleteConfirmDescription")}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={(e) => { e.stopPropagation(); setShowDeleteDialog(false); }}>
                            {t("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            className="border-none bg-[#c0392b] text-white hover:bg-[#a33025] focus:ring-[#c0392b]"
                            onClick={(e) => {
                                e.stopPropagation();
                                deleteResume(resume);
                                setShowDeleteDialog(false);
                                toast.success(t("common.deleteSuccess"));
                            }}
                        >
                            {t("common.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </motion.div>
    );
};
