import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { motion } from "framer-motion";
import { useRouter } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import {
  MARKDOWN_TEMPLATES,
  buildMarkdownTemplateResume,
  getMarkdownTemplate,
  getMarkdownTemplateContent,
  type MarkdownTemplate,
} from "@/config";
import { useResumeStore } from "@/store/useResumeStore";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import { THEME_COLORS } from "@/types/resume";

const A4_WIDTH_PX = 793.700787;
const PREVIEW_MODAL_SCALE = 0.529166667;

/**
 * 主题色色板 = 编辑器（SidePanel / MarkdownWorkbench）使用的 THEME_COLORS，
 * 两者同源，避免「模板页一套颜色、编辑器另一套颜色」导致选型后样式对不上。
 */
const FOLLOW_TEMPLATE_COLOR = "";
const COLOR_CYCLE = [FOLLOW_TEMPLATE_COLOR, ...THEME_COLORS];

interface TemplateCardItemProps {
  index: number;
  template: MarkdownTemplate;
  templateName: string;
  templateDescription: string;
  locale: string;
  onPreview: () => void;
  onUseTemplate: () => void;
  previewLabel: string;
  useTemplateLabel: string;
}

const TemplateCardItem = ({
  index,
  template,
  templateName,
  templateDescription,
  locale,
  onPreview,
  onUseTemplate,
  previewLabel,
  useTemplateLabel,
}: TemplateCardItemProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.24);

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) {
        setScale(width / A4_WIDTH_PX);
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 模板卡片缩略图固定使用「模板自身默认色」——每个模板展示自己的配色，
  // 不再跟随顶部全局色板，避免所有卡片被统一成同一种颜色。
  // 顶部色板只在「预览弹窗 / 使用此模板」时生效（见下方 handleCreateResume 与弹窗）。
  const previewResume = buildMarkdownTemplateResume(
    template,
    locale,
    "" // 空串 → 跟随模板默认色
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.08 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      <Card
        className={cn(
          "group border transition-all duration-200 aspect-[210/297] flex flex-col overflow-hidden",
          "hover:border-primary/40 hover:shadow-lg",
          "dark:hover:border-primary/40"
        )}
      >
        <CardContent
          className="p-0 flex-1 relative bg-gray-50 dark:bg-gray-900 overflow-hidden cursor-pointer"
          onClick={onPreview}
        >
          <div
            className="absolute inset-0 pb-6 flex items-center justify-center pointer-events-none transition-transform duration-300 group-hover:scale-[1.02] overflow-hidden"
            ref={containerRef}
          >
            <div className="w-full h-full relative origin-top bg-white">
              <div
                className="resume-preview absolute top-0 left-0 bg-white"
                style={{
                  width: "210mm",
                  height: "297mm",
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
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

          <div className="absolute inset-x-0 bottom-0 top-[60%] pointer-events-none bg-gradient-to-t from-white via-white/90 to-transparent dark:from-gray-950 dark:via-gray-950/90 z-0" />
          <div className="absolute inset-x-0 bottom-0 pt-12 pb-3 px-4 flex items-end border-t border-transparent z-10 transition-colors group-hover:bg-white/50 dark:group-hover:bg-gray-950/50">
            <div className="flex flex-col w-full">
              <span className="text-[15px] font-semibold truncate text-gray-900 dark:text-gray-100 drop-shadow-sm">
                {templateName}
              </span>
              <span className="text-[11px] text-gray-600 dark:text-gray-300 mt-0.5 font-medium truncate">
                {templateDescription}
              </span>
            </div>
          </div>
        </CardContent>

        <CardFooter className="pt-2 pb-2 px-2 bg-white dark:bg-gray-950 border-t border-gray-100 dark:border-gray-800 z-10">
          <div className="grid grid-cols-2 gap-2 w-full">
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Button
                variant="outline"
                className="w-full text-sm hover:bg-gray-100 dark:border-primary/50 dark:hover:bg-primary/10"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview();
                }}
              >
                {previewLabel}
              </Button>
            </motion.div>

            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Button
                className="w-full text-sm"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onUseTemplate();
                }}
              >
                {useTemplateLabel}
              </Button>
            </motion.div>
          </div>
        </CardFooter>
      </Card>
    </motion.div>
  );
};

const TemplatesPage = () => {
  const t = useTranslations("dashboard.templates");
  const locale = useLocale();
  const router = useRouter();
  const createResume = useResumeStore((state) => state.createResume);
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState<string>(FOLLOW_TEMPLATE_COLOR);

  const handleColorSelect = (value: string) => {
    setSelectedColor(value);
  };

  const activePreviewTemplate = previewTemplateId
    ? getMarkdownTemplate(previewTemplateId)
    : null;

  // 「使用此模板」：创建后写入模板示例 Markdown + 模板排版设置 + 当前主题色，
  // 保证进编辑器后看到的内容与模板卡片预览一致（编辑器同样以 markdownContent 为源）。
  const handleCreateResume = async (templateId: string) => {
    const template = getMarkdownTemplate(templateId);

    const resumeId = await createResume(template.id);
    const { resumes, updateResume } = useResumeStore.getState();
    const resume = resumes[resumeId];

    if (resume) {
      updateResume(resumeId, {
        templateId: template.id,
        markdownContent: getMarkdownTemplateContent(template, locale),
        globalSettings: {
          ...resume.globalSettings,
          ...template.globalSettings,
          themeColor: selectedColor || template.themeColor,
        },
      });
    }

    router.push({ to: "/app/workbench/$id", params: { id: resumeId } });
  };

  return (
    <ScrollArea className="h-[calc(100vh-2rem)] w-full">
      <div className="w-full max-w-[1600px] mx-auto py-8 px-4 sm:px-6">
        <div className="flex flex-col space-y-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h2 className="text-3xl font-bold tracking-tight">{t("title")}</h2>

            <div className="flex items-center space-x-2 bg-gray-50/50 dark:bg-gray-900/50 p-2 rounded-full border border-gray-100 dark:border-gray-800 backdrop-blur-sm self-start sm:self-auto overflow-x-auto">
              {COLOR_CYCLE.map((color, index) => {
                const isFollowTemplate = color === FOLLOW_TEMPLATE_COLOR;
                return (
                  <button
                    key={isFollowTemplate ? "follow-template" : color}
                    type="button"
                    onClick={() => handleColorSelect(color)}
                    className={cn(
                      "relative w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-110",
                      selectedColor === color
                        ? "ring-2 ring-primary ring-offset-2 dark:ring-offset-gray-950 scale-110"
                        : ""
                    )}
                    title={
                      isFollowTemplate ? t("defaultColor") : `${t("themeColor")} ${index}`
                    }
                  >
                    {isFollowTemplate ? (
                      <div className="w-full h-full rounded-full bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 border border-gray-300 dark:border-gray-700 shadow-sm flex items-center justify-center">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium tracking-tighter">
                          Tpl
                        </span>
                      </div>
                    ) : (
                      <div
                        className="w-full h-full rounded-full border border-black/10 dark:border-white/10 shadow-sm"
                        style={{ backgroundColor: color }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-6">
            {MARKDOWN_TEMPLATES.map((template, index) => (
              <TemplateCardItem
                key={template.id}
                index={index}
                template={template}
                templateName={t(`${template.nameKey}.name`)}
                templateDescription={t(`${template.nameKey}.description`)}
                locale={locale}
                onPreview={() => setPreviewTemplateId(template.id)}
                onUseTemplate={() => handleCreateResume(template.id)}
                previewLabel={t("preview")}
                useTemplateLabel={t("useTemplate")}
              />
            ))}
          </div>

          <Dialog
            open={!!activePreviewTemplate}
            onOpenChange={(open) => {
              if (!open) setPreviewTemplateId(null);
            }}
          >
            {activePreviewTemplate && (
              <DialogContent className="max-w-[680px] p-0 overflow-hidden border-0 shadow-lg rounded-xl bg-white dark:bg-gray-900">
                <div className="flex flex-col">
                  <div className="border-b border-gray-100 dark:border-gray-800 px-4 py-4">
                    <DialogTitle className="text-lg font-medium">
                      {t(`${activePreviewTemplate.nameKey}.name`)}
                    </DialogTitle>
                  </div>
                  <div className="overflow-hidden flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-8 pointer-events-none">
                    <div
                      className="relative bg-white shadow-md ring-1 ring-gray-200/50 overflow-hidden"
                      style={{ width: "420px", height: "594px" }}
                    >
                      <div
                        className="resume-preview absolute top-0 left-0 bg-white"
                        style={{
                          width: "210mm",
                          height: "297mm",
                          transform: `scale(${PREVIEW_MODAL_SCALE})`,
                          transformOrigin: "top left",
                        }}
                      >
                        <MarkdownPreview
                          embedded
                          markdown={getMarkdownTemplateContent(
                            activePreviewTemplate,
                            locale
                          )}
                          resume={buildMarkdownTemplateResume(
                            activePreviewTemplate,
                            locale,
                            selectedColor
                          )}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="p-3 pt-2 border-t border-gray-100 dark:border-gray-800 flex justify-center">
                    <Button
                      className="w-full"
                      onClick={() => {
                        const templateId = activePreviewTemplate.id;
                        setPreviewTemplateId(null);
                        handleCreateResume(templateId);
                      }}
                    >
                      {t("useTemplate")}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            )}
          </Dialog>
        </div>
      </div>
    </ScrollArea>
  );
};

export const runtime = "edge";

export default TemplatesPage;
