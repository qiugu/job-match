import React from "react";
import { useLocale, useTranslations } from "@/i18n/compat/client";
import { motion } from "framer-motion";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet-no-overlay";
import { cn } from "@/lib/utils";
import {
  MARKDOWN_TEMPLATES,
  buildMarkdownTemplateResume,
  getMarkdownTemplateContent,
  type MarkdownTemplate,
} from "@/config";
import { useResumeStore } from "@/store/useResumeStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import { PanelsLeftBottom } from "lucide-react";

const A4_WIDTH_PX = 793.700787;
const A4_HEIGHT_PX = 1122.519685;

interface TemplatePreviewProps {
  template: MarkdownTemplate;
  isActive: boolean;
  onSelect: (templateId: string) => void;
}

const TemplatePreview = ({
  template,
  isActive,
  onSelect,
}: TemplatePreviewProps) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.2);
  const locale = useLocale();

  React.useEffect(() => {
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

  const previewResume = buildMarkdownTemplateResume(template, locale, "");

  return (
    <button
      onClick={() => onSelect(template.id)}
      className={cn(
        "relative group rounded-lg overflow-hidden border-2 transition-all duration-200 hover:scale-[1.02] text-left",
        isActive
          ? "border-primary dark:border-primary shadow-lg dark:shadow-primary/30"
          : "border-gray-100 hover:border-gray-200 dark:border-neutral-800 dark:hover:border-neutral-700"
      )}
    >
      <div
        ref={containerRef}
        className="relative aspect-[210/297] w-full overflow-hidden bg-gray-50 dark:bg-gray-900"
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: scale * A4_WIDTH_PX,
            height: scale * A4_HEIGHT_PX,
          }}
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
      {isActive && (
        <motion.div
          layoutId="template-selected"
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/10 dark:bg-black/40 pointer-events-none"
        >
          <PanelsLeftBottom className="h-8 w-8 text-primary shadow-sm" />
        </motion.div>
      )}
    </button>
  );
};

const TemplateSheet = () => {
  const t = useTranslations("templates");
  const tNames = useTranslations("dashboard.templates");
  const { activeResume, setTemplate } = useResumeStore();

  const currentTemplate =
    MARKDOWN_TEMPLATES.find((template) => template.id === activeResume?.templateId) ||
    MARKDOWN_TEMPLATES[0];

  return (
    <Sheet>
      <SheetTrigger asChild>
        <PanelsLeftBottom size={20} />
      </SheetTrigger>
      <SheetContent side="left" forceMount className="w-1/2 sm:max-w-1/2">
        <SheetHeader>
          <SheetTitle>{t("switchTemplate")}</SheetTitle>
        </SheetHeader>
        <SheetDescription />

        <div className="mt-4 h-[calc(100vh-8rem)]">
          <ScrollArea className="h-full w-full pr-4">
            <div className="grid grid-cols-4 gap-4 pb-8">
              {MARKDOWN_TEMPLATES.map((template) => (
                <div key={template.id} className="flex flex-col gap-2">
                  <TemplatePreview
                    template={template}
                    isActive={template.id === currentTemplate.id}
                    onSelect={setTemplate}
                  />
                  <span className="text-xs text-center text-gray-600 dark:text-gray-400 truncate">
                    {tNames(`${template.nameKey}.name`)}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default TemplateSheet;
