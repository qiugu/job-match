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
          "group flex flex-col overflow-hidden rounded-[10px] border border-xai-hairline bg-xai-surface p-2.5 shadow-none transition-colors duration-200",
          "hover:border-white/60"
        )}
      >
        <CardContent
          className="relative aspect-[210/297] cursor-pointer overflow-hidden rounded-[6px] bg-white p-0"
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

        </CardContent>

        {/* 模板名与说明放在白纸之外，深色卡壳上一目了然 */}
        <div className="flex flex-col gap-1 px-1.5 pb-1 pt-3">
          <span className="truncate text-[14px] font-medium text-white">
            {templateName}
          </span>
          <span className="truncate text-[11px] text-xai-mute">
            {templateDescription}
          </span>
        </div>

        <CardFooter className="z-10 px-1.5 pb-1 pt-3">
          <div className="grid grid-cols-2 gap-2 w-full">
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Button
                variant="outline"
                className="h-9 w-full rounded-full border-xai-hairline bg-transparent text-[12.5px] text-xai-text-mid hover:border-[#3d4048] hover:bg-xai-surface-2 hover:text-white"
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
                className="h-9 w-full rounded-full bg-white text-[12.5px] font-medium text-xai-canvas hover:bg-white/90"
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
      <div className="mx-auto w-full max-w-[1600px] px-6 py-9">
        <div className="flex flex-col space-y-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-2.5">
              <p className="xai-eyebrow">RESUME TEMPLATES — MARKDOWN</p>
              <h2 className="text-[32px] font-medium leading-none tracking-tight text-white">
                {t("title")}
              </h2>
              <p className="text-[13px] text-xai-mute">{t("subtitle")}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
              <div className="flex items-center rounded-full border border-xai-hairline bg-xai-surface px-4 py-3">
                <span className="xai-eyebrow text-[10px]">
                  {String(MARKDOWN_TEMPLATES.length).padStart(2, "0")} TEMPLATES
                </span>
              </div>

              <div className="flex items-center gap-2 rounded-full border border-xai-hairline bg-xai-surface px-3 py-2.5">
              {COLOR_CYCLE.map((color, index) => {
                const isFollowTemplate = color === FOLLOW_TEMPLATE_COLOR;
                return (
                  <button
                    key={isFollowTemplate ? "follow-template" : color}
                    type="button"
                    onClick={() => handleColorSelect(color)}
                    className={cn(
                      "relative flex size-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110",
                      selectedColor === color
                        ? "scale-110 ring-2 ring-white ring-offset-2 ring-offset-xai-surface"
                        : ""
                    )}
                    title={
                      isFollowTemplate ? t("defaultColor") : `${t("themeColor")} ${index}`
                    }
                  >
                    {isFollowTemplate ? (
                      <div className="flex h-full w-full items-center justify-center rounded-full border border-xai-hairline bg-xai-surface-2">
                        <span className="font-mono text-[9px] uppercase tracking-tighter text-xai-mute">
                          Tpl
                        </span>
                      </div>
                    ) : (
                      <div
                        className="h-full w-full rounded-full border border-white/15"
                        style={{ backgroundColor: color }}
                      />
                    )}
                  </button>
                );
              })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
              <DialogContent className="max-w-[680px] overflow-hidden rounded-2xl border border-xai-hairline bg-xai-surface p-0 shadow-none">
                <div className="flex flex-col">
                  <div className="flex flex-col gap-1.5 border-b border-xai-hairline px-5 py-4">
                    <p className="xai-eyebrow text-[10px]">TEMPLATE PREVIEW</p>
                    <DialogTitle className="text-[18px] font-medium text-white">
                      {t(`${activePreviewTemplate.nameKey}.name`)}
                    </DialogTitle>
                  </div>
                  <div className="flex items-center justify-center overflow-hidden bg-xai-canvas py-8 pointer-events-none">
                    <div
                      className="relative overflow-hidden bg-white ring-1 ring-black/10"
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
                  <div className="flex justify-center border-t border-xai-hairline p-4">
                    <Button
                      className="h-10 w-full rounded-full bg-white text-[13px] font-medium text-xai-canvas hover:bg-white/90"
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
