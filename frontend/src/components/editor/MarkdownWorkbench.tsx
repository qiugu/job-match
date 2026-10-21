import React, { useState, useRef } from "react";
import { motion } from "framer-motion";
import { FileText, Eye, Palette } from "lucide-react";
import { useResumeStore } from "@/store/useResumeStore";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/i18n/compat/client";
import { DEFAULT_PAGE_PADDING, THEME_COLORS } from "@/types/resume";
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
      {/* 模式内提示条 + 主题色选择 */}
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-2 text-xs border-b shrink-0",
          "bg-muted/40 text-muted-foreground border-border"
        )}
      >
        <div className="flex items-center gap-2">
          <FileText className="w-3.5 h-3.5" />
          <span>{t("modeHint")}</span>
        </div>

        {/* Markdown 主题色选择：复用 globalSettings.themeColor 与 THEME_COLORS */}
        <div className="ml-auto flex items-center gap-2">
          <Palette className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{tTheme("title")}</span>
          <div className="flex items-center gap-1.5">
            {THEME_COLORS.map((presetTheme) => (
              <button
                key={presetTheme}
                type="button"
                aria-label={presetTheme}
                title={presetTheme}
                onClick={() => handleThemeColorChange(presetTheme)}
                className={cn(
                  "relative w-4 h-4 rounded-full overflow-hidden transition-all duration-200 focus:outline-none",
                  themeColor === presetTheme
                    ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
                    : "ring-1 ring-border hover:ring-primary/50 hover:scale-110"
                )}
              >
                <span
                  className="absolute inset-0"
                  style={{ backgroundColor: presetTheme }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
          {/* 左：Markdown 编辑器 */}
          <ResizablePanel
            id="markdown-editor-panel"
            order={1}
            defaultSize={previewPanelCollapsed ? 100 : 50}
            minSize={30}
            className="min-h-0 bg-background"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div
                className={cn(
                  "flex items-center gap-2 px-4 py-2 text-xs font-medium",
                  "border-b bg-background border-border text-muted-foreground"
                )}
              >
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

          {!previewPanelCollapsed && <ResizableHandle />}

          {/* 右：实时预览 */}
          {!previewPanelCollapsed && (
            <ResizablePanel
              id="markdown-preview-panel"
              order={2}
              defaultSize={50}
              minSize={30}
              className="min-h-0 bg-muted"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div
                  className={cn(
                    "flex items-center gap-3 overflow-x-auto border-b bg-background px-4 py-2 text-xs font-medium text-muted-foreground"
                  )}
                >
                  <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                    <Eye className="h-3.5 w-3.5" />
                    <p className="xai-eyebrow">{t("previewTitle")}</p>
                  </div>

                  {/* 行高 / 字号 / 边距 调节（分页按内容真实块边界切分，文字不会被页边界截断） */}
                  <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
                    {/* 一页纸开关 chip：开启后超出单页的内容自动缩放至一页 */}
                    <button
                      type="button"
                      onClick={() =>
                        updateGlobalSettings({
                          autoOnePage: !activeResume.globalSettings?.autoOnePage,
                        })
                      }
                      className={cn(
                        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[10px] transition-colors",
                        activeResume.globalSettings?.autoOnePage
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : "border-border text-muted-foreground hover:text-foreground"
                      )}
                      title="超出单页的内容自动缩放至一页"
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          activeResume.globalSettings?.autoOnePage
                            ? "bg-emerald-400"
                            : "bg-muted-foreground/40"
                        )}
                      />
                      一页纸已开启
                    </button>

                    <label className="flex items-center gap-1.5" title="行高">
                      <span>行高</span>
                      <input
                        type="range"
                        min={1.15}
                        max={2}
                        step={0.05}
                        value={activeResume.globalSettings?.lineHeight || 1.5}
                        onChange={(e) =>
                          updateGlobalSettings({
                            lineHeight: Number(e.target.value),
                          })
                        }
                        className="w-20 accent-primary"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {(activeResume.globalSettings?.lineHeight || 1.5).toFixed(2)}
                      </span>
                    </label>

                    <label className="flex items-center gap-1.5" title="字体大小">
                      <span>字号</span>
                      <input
                        type="range"
                        min={12}
                        max={20}
                        step={1}
                        value={activeResume.globalSettings?.baseFontSize || 16}
                        onChange={(e) =>
                          updateGlobalSettings({
                            baseFontSize: Number(e.target.value),
                          })
                        }
                        className="w-20 accent-primary"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {activeResume.globalSettings?.baseFontSize || 16}
                      </span>
                    </label>

                    <label className="flex items-center gap-1.5" title="页面内边距">
                      <span>边距</span>
                      <input
                        type="range"
                        min={16}
                        max={64}
                        step={2}
                        value={activeResume.globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING}
                        onChange={(e) =>
                          updateGlobalSettings({
                            pagePadding: Number(e.target.value),
                          })
                        }
                        className="w-20 accent-primary"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {activeResume.globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING}
                      </span>
                    </label>

                    {/* 模块间距：h2 顶级模块标题上方的留白（px）。
                        未设置时与预览渲染一致（半行高），拖动滑块后写入 sectionSpacing 固定像素值 */}
                    <label
                      className="flex items-center gap-1.5"
                      title="模块间距：h2 顶级模块标题上方的留白"
                    >
                      <span>模块间距</span>
                      <input
                        type="range"
                        min={0}
                        max={64}
                        step={2}
                        value={moduleSpacing}
                        onChange={(e) =>
                          updateGlobalSettings({
                            sectionSpacing: Number(e.target.value),
                          })
                        }
                        className="w-20 accent-primary"
                      />
                      <span className="w-8 text-right tabular-nums">
                        {moduleSpacing}
                      </span>
                    </label>
                  </div>
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
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
};

export default MarkdownWorkbench;
