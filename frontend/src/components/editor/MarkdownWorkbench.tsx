import React, { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import { Eye, ListChecks } from "lucide-react";
import { type ImperativePanelHandle } from "react-resizable-panels";
import { useResumeStore } from "@/store/useResumeStore";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/i18n/compat/client";
import { DEFAULT_PAGE_PADDING, THEME_COLORS } from "@/types/resume";
import { getFontOptions, normalizeFontFamily } from "@/utils/fonts";
import MarkdownEditor from "@/components/editor/MarkdownEditor";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";

interface MarkdownWorkbenchProps {
  previewPanelCollapsed: boolean;
  resumeContentRef: React.RefObject<HTMLDivElement>;
}

// Markdown 编辑模式主布局：左为 Markdown 编辑器，右为实时预览。
// 数据流：Markdown 源 -> 编辑器 -> store.markdownContent
//        -> 预览组件解析渲染（同时驱动 PDF 导出）。
const MarkdownWorkbench = ({
  previewPanelCollapsed,
  resumeContentRef,
}: MarkdownWorkbenchProps) => {
  const { activeResume, updateResume, setThemeColor, updateGlobalSettings, saveActiveResumeToBackend, syncedIds } =
    useResumeStore();
  const t = useTranslations("markdownEditor");
  const tTheme = useTranslations("workbench.sidePanel.theme");
  const tTypo = useTranslations("workbench.sidePanel.typography");
  const tSpacing = useTranslations("workbench.sidePanel.spacing");
  const previewPanelRef = useRef<ImperativePanelHandle>(null);
  // activeResume 就绪前组件整体 return null，面板未挂载、ref 为 null；
  // 若这期间用户切换了折叠态，collapse/expand 会静默丢失（旧版故障模式）。
  // 把就绪状态纳入依赖，确保面板挂载后立即同步当前折叠态。
  const resumeReady = !!activeResume;

  useEffect(() => {
    // 面板与 PanelGroup 可能同帧挂载（activeResume 刚就绪的瞬间）：此时 Group
    // 的内部布局尚未初始化完毕，同帧调用 collapse 会读到未就绪状态而静默失败
    // （表现为「状态显示已收起、面板却没收起」——旧版故障模式）。
    // 延后一帧，确保 Group 完成初始化后再同步折叠态。
    const raf = requestAnimationFrame(() => {
      if (previewPanelCollapsed) {
        previewPanelRef.current?.collapse();
      } else {
        // 不传尺寸：rrp 会恢复到 collapse 前的宽度（只要不小于面板 minSize）；
        // 传 50 会把用户自定义过的窄宽度顶回 50%。
        previewPanelRef.current?.expand();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [previewPanelCollapsed, resumeReady]);

  // 主题色改动后自动落库（防抖），避免「在编辑器选了不同主题色、没点保存就回列表页，
  // 列表页从后端重载把未保存的改动覆盖掉」导致缩略图显示的还是旧色、不同简历同色。
  const themeColorSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleThemeColorChange = (color: string) => {
    setThemeColor(color);
    if (themeColorSaveTimer.current) clearTimeout(themeColorSaveTimer.current);
    themeColorSaveTimer.current = setTimeout(() => {
      saveActiveResumeToBackend().catch((err) => {
        console.error("主题色自动保存失败:", err);
      });
    }, 600);
  };

  if (!activeResume) return null;

  const themeColor = activeResume?.globalSettings?.themeColor || THEME_COLORS[0];
  // 字体 seg：映射既有 globalSettings.fontFamily（与 SidePanel/预览渲染同一口径）
  const fontOptions = getFontOptions((key) => tTypo(`font.${key}`));
  const selectedFont = normalizeFontFamily(activeResume?.globalSettings?.fontFamily);
  // 模块间距：与预览渲染保持同一口径（未设置时 = 半行高），滑块所见即所得
  const lineUnit = Math.round(
    (activeResume?.globalSettings?.lineHeight || 1.5) *
      (activeResume?.globalSettings?.baseFontSize || 16)
  );
  const moduleSpacing =
    activeResume?.globalSettings?.sectionSpacing ??
    Math.round(lineUnit * 0.5);

  const handleChange = (markdown: string) => {
    updateResume(activeResume.id, { markdownContent: markdown });
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
          {/* 左：排版设置（设计稿 03 .set：20% / Calm 档） */}
          <ResizablePanel
            id="typeset-panel"
            order={1}
            defaultSize={20}
            minSize={15}
            maxSize={30}
            className="min-h-0 bg-paper-2 border-r border-line"
          >
            <div className="h-full overflow-y-auto">
              {/* set__top：面板标题 + auto-save eyebrow */}
              <div className="flex items-center gap-2 px-4 pt-3.5 pb-3 border-b border-line">
                <ListChecks className="w-3.5 h-3.5 text-ink-2" />
                <b className="text-xs font-semibold text-ink">{t("typeset.title")}</b>
                <span className="ml-auto font-mono text-[9px] tracking-wider text-ink-3">
                  {t("typeset.autoSave")}
                </span>
              </div>

              {/* 字体：seg 按钮组（globalSettings.fontFamily） */}
              <div className="px-4 pt-3.5">
                <p className="text-[10.5px] font-semibold text-ink-3 mb-1.5">
                  {tTypo("font.title")}
                </p>
                <div className="grid grid-cols-2 gap-0.5 p-[3px] bg-paper border border-line rounded-lg">
                  {fontOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() =>
                        updateGlobalSettings({ fontFamily: option.value })
                      }
                      className={cn(
                        "h-6 rounded-md text-[11px] transition-colors",
                        selectedFont === option.value
                          ? "bg-card text-ink font-semibold shadow-sm"
                          : "text-ink-2 hover:bg-paper-2"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 字号 · 行距 */}
              <div className="px-4 pt-4">
                <p className="text-[10.5px] font-semibold text-ink-3 mb-1">
                  {t("typeset.sizeLeading")}
                </p>
                <div className="flex items-baseline justify-between text-[11px] text-ink-2">
                  <span>{tTypo("baseFontSize.title")}</span>
                  <b className="font-mono text-[10px] font-medium text-ink">
                    {activeResume.globalSettings?.baseFontSize || 16}
                  </b>
                </div>
                <input
                  type="range"
                  min={12}
                  max={20}
                  step={1}
                  value={activeResume.globalSettings?.baseFontSize || 16}
                  onChange={(e) =>
                    updateGlobalSettings({ baseFontSize: Number(e.target.value) })
                  }
                  className="pp-slider mt-2.5 mb-1.5 mx-1"
                />
                <div className="flex items-baseline justify-between text-[11px] text-ink-2">
                  <span>{tTypo("lineHeight.title")}</span>
                  <b className="font-mono text-[10px] font-medium text-ink">
                    {(activeResume.globalSettings?.lineHeight || 1.5).toFixed(2)}
                  </b>
                </div>
                <input
                  type="range"
                  min={1.15}
                  max={2}
                  step={0.05}
                  value={activeResume.globalSettings?.lineHeight || 1.5}
                  onChange={(e) =>
                    updateGlobalSettings({ lineHeight: Number(e.target.value) })
                  }
                  className="pp-slider mt-2.5 mb-1.5 mx-1"
                />
              </div>

              {/* 间距：页边距 + 模块间距 */}
              <div className="px-4 pt-3">
                <p className="text-[10.5px] font-semibold text-ink-3 mb-1">
                  {tSpacing("title")}
                </p>
                <div className="flex items-baseline justify-between text-[11px] text-ink-2">
                  <span>{tSpacing("pagePadding.title")}</span>
                  <b className="font-mono text-[10px] font-medium text-ink">
                    {activeResume.globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING}
                  </b>
                </div>
                <input
                  type="range"
                  min={16}
                  max={64}
                  step={2}
                  value={activeResume.globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING}
                  onChange={(e) =>
                    updateGlobalSettings({ pagePadding: Number(e.target.value) })
                  }
                  className="pp-slider mt-2.5 mb-1.5 mx-1"
                />
                <div className="flex items-baseline justify-between text-[11px] text-ink-2">
                  <span>{tSpacing("sectionSpacing.title")}</span>
                  <b className="font-mono text-[10px] font-medium text-ink">
                    {moduleSpacing}
                  </b>
                </div>
                <input
                  type="range"
                  min={0}
                  max={64}
                  step={2}
                  value={moduleSpacing}
                  onChange={(e) =>
                    updateGlobalSettings({ sectionSpacing: Number(e.target.value) })
                  }
                  className="pp-slider mt-2.5 mb-1.5 mx-1"
                />
              </div>

              {/* 强调色：swatches（THEME_COLORS） */}
              <div className="px-4 pt-3 pb-6">
                <p className="text-[10.5px] font-semibold text-ink-3 mb-2">
                  {tTheme("title")}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {THEME_COLORS.map((presetTheme) => (
                    <button
                      key={presetTheme}
                      type="button"
                      aria-label={presetTheme}
                      title={presetTheme}
                      onClick={() => handleThemeColorChange(presetTheme)}
                      className={cn(
                        "w-5 h-5 rounded-full border-[1.5px] border-ink shrink-0 transition-all",
                        themeColor === presetTheme &&
                          "shadow-[0_0_0_2px_var(--paper-2),0_0_0_3.5px_var(--ink)]"
                      )}
                      style={{ backgroundColor: presetTheme }}
                    />
                  ))}
                  <span className="ml-auto font-mono text-[9px] text-ink-3">
                    {themeColor.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* 中：Markdown 编辑（32% / 编辑态） */}
          <ResizablePanel
            id="markdown-editor-panel"
            order={2}
            defaultSize={32}
            minSize={22}
            className="min-h-0 bg-background"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-line bg-card">
                <p className="xai-eyebrow">{t("editorTitle")}</p>
              </div>
              <div className="min-h-0 flex-1">
                <MarkdownEditor
                  value={activeResume.markdownContent ?? ""}
                  onChange={handleChange}
                  placeholder={t("placeholder")}
                />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* 右：实时预览（48% / 产出态） */}
          <ResizablePanel
            ref={previewPanelRef}
            id="markdown-preview-panel"
            order={3}
            collapsible
            collapsedSize={0}
            defaultSize={48}
            minSize={25}
            className="min-h-0 bg-paper-2"
          >
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-line bg-card">
                  <Eye className="h-3.5 w-3.5 text-ink-2" />
                  <p className="xai-eyebrow">{t("previewTitle")}</p>
                  <span className="ml-auto font-mono text-[9px] px-1.5 py-0.5 border border-line rounded text-ink-3">
                    A4
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                {/* 显式传入 activeResume：版式变体按 resume.templateId 解析，
                    用户在模板页选的版式在进入编辑器后才不会丢。 */}
                <MarkdownPreview
                  ref={resumeContentRef}
                  markdown={activeResume.markdownContent ?? ""}
                  resume={activeResume}
                />
                </div>
              </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
};

export default MarkdownWorkbench;
