import React, { useCallback } from "react";
import {
  Home,
  Copy,
  Download,
  Eye,
  PanelsLeftBottom,
  SpellCheck2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import TemplateSheet from "@/components/shared/TemplateSheet";
import { useResumeStore } from "@/store/useResumeStore";
import { useGrammarCheck } from "@/hooks/useGrammarCheck";
import { GrammarCheckDrawer } from "@/components/editor/grammar/GrammarCheckDrawer";
import { FAQDialog } from "./FAQDialog";
import PdfExport from "@/components/shared/PdfExport";
import { cn } from "@/lib/utils";

interface PreviewDockProps {
  previewPanelCollapsed: boolean;
  togglePreviewPanel: () => void;
}

/**
 * 右侧竖向工具条。
 *
 * I16 收口：旧实现用 magicui Dock + DockIcon，导致同一竖列并存三种体量
 * （13–14px 线图标 / 28px 实心方块 / 44px FAQ 圆钮）、两种节奏（手写
 * 分隔线落在 gap-2 的 flex 流里，白拿两份间距）与三级圆角（容器 16 /
 * DockIcon 2 / 按钮 8），且 DockIcon 的 hover 与按钮 hover 双层叠色。
 * 这里改为单一 28px chip + 单一 gap + 两级圆角（容器 xl、内部 lg），
 * 激活态只换色不改尺寸。
 *
 * I12：删除 MagicThread 的 repeat: Infinity 常驻虚线脉冲。
 * I13：激活态用墨色（状态），不再与主操作抢钴蓝信号色。
 */
const DOCK_BUTTON_CLASS = cn(
  "flex h-7 w-7 items-center justify-center rounded-lg text-ink-2",
  "transition-colors hover:bg-paper-2 hover:text-ink",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40",
  "disabled:cursor-not-allowed disabled:opacity-50"
);

const DOCK_ACTIVE_CLASS = "bg-ink text-paper hover:bg-ink hover:text-paper";

/** 分组分隔线：作为极细线参与同一 gap 网格，不额外撑开双倍间距 */
const DockDivider = () => (
  <div aria-hidden className="my-0.5 h-px w-5 bg-line" />
);

const PreviewDock = ({
  previewPanelCollapsed,
  togglePreviewPanel,
}: PreviewDockProps) => {
  const router = useRouter();
  const t = useTranslations("previewDock");
  const tGrammar = useTranslations("grammarCheck");
  // 校对入口回归 Dock 后，错误数角标也由 Dock 自己订阅：
  // 顶部工具行不再承担「校对状态」的展示职责。
  const { errors } = useGrammarCheck();

  const { duplicateResume, setActiveResume, activeResumeId } = useResumeStore();

  /** 打开校对抽屉并触发一次 AI 校对（由抽屉自身监听该事件） */
  const openGrammarDrawer = useCallback(() => {
    document.dispatchEvent(new CustomEvent("open-grammar-drawer"));
  }, []);

  const handleCopyResume = useCallback(() => {
    if (!activeResumeId) return;
    try {
      const newId = duplicateResume(activeResumeId);
      const targetPath = `/app/workbench/${newId}`;
      setActiveResume(newId);
      toast.success(t("copyResume.success"));
      router.push({ to: "/app/workbench/$id", params: { id: newId } });

      requestAnimationFrame(() => {
        if (window.location.pathname !== targetPath) {
          window.location.assign(targetPath);
        }
      });
    } catch {
      toast.error(t("copyResume.error"));
    }
  }, [activeResumeId, duplicateResume, router, setActiveResume, t]);

  return (
    <div className="fixed right-3 top-1/2 z-[50] hidden -translate-y-1/2 md:block">
      <TooltipProvider delayDuration={0}>
        <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-card p-1.5 shadow-[var(--shadow-chip)]">
          {/* 模板 */}
          <Tooltip>
            <TemplateSheet
              trigger={
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("switchTemplate")}
                    className={DOCK_BUTTON_CLASS}
                  >
                    <PanelsLeftBottom className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
              }
            />
            <TooltipContent side="left" sideOffset={10}>
              <p>{t("switchTemplate")}</p>
            </TooltipContent>
          </Tooltip>

          {/* 导出 */}
          <Tooltip>
            <PdfExport>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("export.tooltip")}
                  className={DOCK_BUTTON_CLASS}
                >
                  <Download className="h-4 w-4" />
                </button>
              </TooltipTrigger>
            </PdfExport>
            <TooltipContent side="left" sideOffset={10}>
              <p>{t("export.tooltip")}</p>
            </TooltipContent>
          </Tooltip>

          {/* 复制简历 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("copyResume.tooltip")}
                className={DOCK_BUTTON_CLASS}
                onClick={handleCopyResume}
              >
                <Copy className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={10}>
              <p>{t("copyResume.tooltip")}</p>
            </TooltipContent>
          </Tooltip>

          <DockDivider />

          {/* 校对：入口回到 Dock —— 它操作的对象是「预览里的正文」，
              与模板/导出/复制同属一类。结果计数用角标挂在图标上，
              不再在顶部工具行另开一个与「保存」抢权重的横排按钮。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-dock-proofread
                aria-label={tGrammar("proofread")}
                onClick={openGrammarDrawer}
                className={cn(DOCK_BUTTON_CLASS, "relative")}
              >
                <SpellCheck2 className="h-4 w-4" />
                {errors.length > 0 && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-1 -top-1 grid h-[14px] min-w-[14px] place-items-center",
                      "rounded-full bg-tangerine px-[3px] text-[9px] font-semibold leading-none text-paper"
                    )}
                  >
                    {errors.length > 9 ? "9+" : errors.length}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={10}>
              {errors.length > 0
                ? tGrammar("found_issues", { count: errors.length })
                : tGrammar("proofread")}
            </TooltipContent>
          </Tooltip>

          <DockDivider />

          {/* 预览面板展开/收起：激活（展开）只换色，不放大 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={
                  previewPanelCollapsed
                    ? t("previewPanel.expand")
                    : t("previewPanel.collapse")
                }
                aria-pressed={!previewPanelCollapsed}
                onClick={togglePreviewPanel}
                className={cn(
                  DOCK_BUTTON_CLASS,
                  !previewPanelCollapsed && DOCK_ACTIVE_CLASS
                )}
              >
                <Eye className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={10}>
              {previewPanelCollapsed
                ? t("previewPanel.expand")
                : t("previewPanel.collapse")}
            </TooltipContent>
          </Tooltip>

          <DockDivider />

          {/* 返回仪表盘 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("backToDashboard")}
                className={DOCK_BUTTON_CLASS}
                onClick={() => router.push("/app/dashboard")}
              >
                <Home className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={10}>
              <p>{t("backToDashboard")}</p>
            </TooltipContent>
          </Tooltip>

          <DockDivider />

          {/* FAQ：与其它项统一为 28px chip（compact），不再是大号贴纸 */}
          <FAQDialog compact />
        </div>
      </TooltipProvider>

      {/* 校对抽屉挂在这里（Portal 渲染到 body，不受外层 hidden 影响），
          统一由 Dock 作为「校对」这一能力的宿主：入口与抽屉同处一地，
          不再出现「按钮在顶部、抽屉在别处」的跨组件依赖。 */}
      <GrammarCheckDrawer />
    </div>
  );
};

export default PreviewDock;
