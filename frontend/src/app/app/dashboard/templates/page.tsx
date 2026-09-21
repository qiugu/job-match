import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { motion, useReducedMotion } from "framer-motion";
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
import { getTemplateCardLabel } from "@/app/app/dashboard/pagePresentation";

const A4_WIDTH_PX = 793.700787;
const PREVIEW_MODAL_SCALE = 0.529166667;

/**
 * 主题色色板 = 编辑器（SidePanel / MarkdownWorkbench）使用的 THEME_COLORS，
 * 两者同源，避免「模板页一套颜色、编辑器另一套颜色」导致选型后样式对不上。
 */
const DEFAULT_THEME_COLOR = THEME_COLORS[0];
const COLOR_CYCLE = THEME_COLORS;

interface TemplateCardItemProps {
  index: number;
  total: number;
  themeColor: string;
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
  total,
  themeColor,
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
  const shouldReduceMotion = useReducedMotion();

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

  const previewResume = buildMarkdownTemplateResume(
    template,
    locale,
    themeColor
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.3, delay: shouldReduceMotion ? 0 : index * 0.08 }}
      whileHover={shouldReduceMotion ? undefined : { y: -4 }}
      whileTap={shouldReduceMotion ? undefined : { scale: 0.99 }}
    >
      <Card
        aria-label={getTemplateCardLabel(index, total)}
        className={cn(
          "group flex flex-col overflow-hidden rounded-2xl border border-xai-hairline bg-xai-surface p-2.5 shadow-[0_18px_40px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] duration-200",
          "hover:border-xai-hairline-strong hover:shadow-[0_22px_48px_rgba(0,0,0,0.18)]"
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
            <div className="relative h-full w-full origin-top bg-white">
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
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[14px] font-medium text-xai-text">
              {templateName}
            </span>
            <span className="font-mono text-[10px] text-xai-eyebrow">
              {String(index + 1).padStart(2, "0")}
            </span>
          </div>
          <span className="line-clamp-2 min-h-8 text-[11px] leading-relaxed text-xai-mute">
            {templateDescription}
          </span>
        </div>

        <CardFooter className="z-10 px-1.5 pb-1 pt-3">
          <div className="grid grid-cols-2 gap-2 w-full">
            <motion.div
              whileHover={shouldReduceMotion ? undefined : { scale: 1.02 }}
              whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Button
                variant="outline"
                className="h-8 w-full rounded-full border-xai-hairline bg-transparent text-[11px] text-xai-text-mid hover:border-xai-hairline-strong hover:bg-xai-surface-2 hover:text-xai-text"
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
              whileHover={shouldReduceMotion ? undefined : { scale: 1.02 }}
              whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Button
                className="h-8 w-full rounded-full bg-xai-text text-[11px] font-medium text-xai-canvas hover:bg-xai-text/90"
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
  const [selectedColor, setSelectedColor] = useState<string>(DEFAULT_THEME_COLOR);

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
          themeColor: selectedColor,
        },
      });
    }

    router.push({ to: "/app/workbench/$id", params: { id: resumeId } });
  };

  return (
    <ScrollArea className="h-[calc(100vh-2rem)] w-full">
      <div className="w-full px-5 py-7 sm:px-6 sm:py-8">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-7 border-b border-xai-hairline-soft pb-7 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="xai-eyebrow">YOUR RESUME / LAYOUT LIBRARY</p>
              <h2 className="mt-3 text-[34px] font-medium leading-[0.98] tracking-[-0.04em] text-xai-text sm:text-[42px]">
                {t("title")}
              </h2>
              <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-xai-mute">{t("subtitle")}</p>
            </div>

            <div className="flex flex-col items-start gap-3 lg:items-end">
              <div className="flex items-center gap-3 text-[11px] text-xai-mute">
                <span className="font-mono text-xai-text">{String(MARKDOWN_TEMPLATES.length).padStart(2, "0")}</span>
                <span>{t("title")}</span>
                <span className="text-xai-hairline-strong">/</span>
                <span>MARKDOWN</span>
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-xai-hairline bg-xai-surface px-3 py-2.5">
                <span className="xai-eyebrow whitespace-nowrap text-[10px]">{t("themeColor")}</span>
                <div className="flex items-center gap-2">
                {COLOR_CYCLE.map((color, index) => {
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => handleColorSelect(color)}
                    className={cn(
                      "relative flex size-7 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110",
                      selectedColor === color
                        ? "scale-110 ring-2 ring-white ring-offset-2 ring-offset-xai-surface"
                        : ""
                    )}
                    title={
                      `${t("themeColor")} ${index + 1}`
                  }
                >
                    <div
                      className="h-full w-full rounded-full border border-white/15"
                      style={{ backgroundColor: color }}
                    />
                  </button>
                );
              })}
                </div>
              </div>
              <p className="text-[11px] text-xai-mute">{t("themeColor")} · {selectedColor}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {MARKDOWN_TEMPLATES.map((template, index) => (
              <TemplateCardItem
                key={template.id}
                index={index}
                total={MARKDOWN_TEMPLATES.length}
                themeColor={selectedColor}
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
            {/* 同 CreateResumeModal：Portal 出 .theme-xai 作用域，需补上以跟随主题 */}
            {activePreviewTemplate && (
              <DialogContent className="theme-xai max-w-[680px] overflow-hidden rounded-2xl border border-xai-hairline bg-xai-surface p-0 shadow-none">
                <div className="flex flex-col">
                  <div className="flex flex-col gap-1.5 border-b border-xai-hairline px-5 py-4">
                    <p className="xai-eyebrow text-[10px]">TEMPLATE PREVIEW</p>
                    <DialogTitle className="text-[18px] font-medium text-xai-text">
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
                      className="h-10 w-full rounded-full bg-xai-text text-[13px] font-medium text-xai-canvas hover:bg-xai-text/90"
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
