import React, { useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FAQ_KEYS } from "@/config/faq";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/i18n/compat/client";

/**
 * FAQ 悬浮入口（Paper & Punch 贴纸按钮）。
 *
 * 原实现是玻璃拟态「魔法球」：blur 光晕 + 径向渐变 SVG + 毛玻璃底，
 * 与纸墨体系（禁 blur、禁渐变、硬偏移阴影）全面冲突，已整体替换为
 * 钴蓝填充 + 墨边 + 硬阴影的圆形贴纸。不带循环动画——永久 bounce 在
 * 硬偏移阴影下视觉上「抖动」，且持续抢动线注意力；仅保留 hover 抬升。
 */
const DynamicHelpIcon = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  (props, ref) => (
    <button
      ref={ref}
      {...props}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-full",
        "border-2 border-ink bg-cobalt text-white shadow-chip",
        "transition-transform duration-200 hover:-translate-y-0.5",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        props.className
      )}
    >
      <HelpCircle className="size-6" />
    </button>
  )
);
DynamicHelpIcon.displayName = "DynamicHelpIcon";

export const FAQDialog = () => {
  const [open, setOpen] = useState(false);
  const t = useTranslations("faqDialog");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <DynamicHelpIcon />
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={16}>
            <p>{t("title")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <HelpCircle className="h-5 w-5" />
            </div>
             {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 max-h-[60vh] overflow-y-auto pr-2">
          <Accordion type="single" collapsible className="w-full">
            {FAQ_KEYS.map((key) => (
              <AccordionItem key={key} value={key}>
                <AccordionTrigger className="text-left text-[15px] font-medium">
                  {t(`items.${key}.question`)}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {t(`items.${key}.answer`)}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </DialogContent>
    </Dialog>
  );
};
