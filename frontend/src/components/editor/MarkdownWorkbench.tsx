import React, { useState, useRef } from "react";
import { motion } from "framer-motion";
import { FileText, Eye, Palette, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useResumeStore } from "@/store/useResumeStore";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/i18n/compat/client";
import { THEME_COLORS } from "@/types/resume";
import MarkdownEditor from "@/components/editor/MarkdownEditor";
import MarkdownPreview from "@/components/preview/MarkdownPreview";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Markdown 编辑模式主布局：左为 Markdown 编辑器，右为实时预览。
// 数据流：Markdown 源 -> 编辑器 -> store.markdownContent
//        -> 预览组件解析渲染（同时驱动 PDF 导出）。
const MarkdownWorkbench = () => {
  const { activeResume, updateResume, setThemeColor, updateGlobalSettings, saveActiveResumeToBackend, syncedIds } =
    useResumeStore();
  const t = useTranslations("markdownEditor");
  const tTheme = useTranslations("workbench.sidePanel.theme");
  const previewRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // 已保存快照：用于与当前简历做深比较，判断是否有未保存的修改
  const savedSnapshotRef = useRef<string | null>(null);

  // 初始化：若简历此前已存过库（id 已在后端 master_resumes），则以其当前内容作为基准，
  // 按钮初始置灰；否则视为新简历，需要用户主动保存。
  if (savedSnapshotRef.current === null) {
    if (activeResume && syncedIds.has(activeResume.id)) {
      savedSnapshotRef.current = JSON.stringify(activeResume);
    } else {
      savedSnapshotRef.current = ""; // 空基准 -> 与任何内容都不等 -> 初始可保存
    }
  }

  // 是否有未保存的修改：当前内容与已保存快照不一致时即为脏数据
  const isDirty =
    activeResume != null &&
    JSON.stringify(activeResume) !== savedSnapshotRef.current;

  const handleSave = async () => {
    if (!activeResume || saving) return;
    setSaving(true);
    try {
      const { created } = await saveActiveResumeToBackend();
      // 保存成功后，以最新内容刷新基准快照，按钮随即置灰直到下次编辑
      savedSnapshotRef.current = JSON.stringify(activeResume);
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      toast.success(created ? "简历已上传到数据库" : "简历已更新到数据库");
    } catch (err) {
      toast.error(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

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
            defaultSize={50}
            minSize={30}
            className="bg-background min-h-0"
          >
            <div className="h-full min-h-0 flex flex-col">
              <div
                className={cn(
                  "flex items-center gap-2 px-4 py-2 text-xs font-medium",
                  "border-b bg-background border-border text-muted-foreground"
                )}
              >
                <FileText className="w-3.5 h-3.5" />
                {t("editorTitle")}
              </div>
              <div className="flex-1 min-h-0">
                <MarkdownEditor
                  value={activeResume.markdownContent}
                  onChange={handleChange}
                  placeholder={t("placeholder")}
                />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* 右：实时预览 */}
          <ResizablePanel
            id="markdown-preview-panel"
            order={2}
            defaultSize={50}
            minSize={30}
            className="bg-gray-100 min-h-0"
          >
            <div className="h-full min-h-0 flex flex-col">
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-2 text-xs font-medium border-b bg-background border-border text-muted-foreground overflow-x-auto"
                )}
              >
                <div className="flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5" />
                  {t("previewTitle")}
                </div>

                {/* 行高 / 字号 / 边距 调节（分页按内容真实块边界切分，文字不会被页边界截断） */}
                <div className="flex items-center gap-3 ml-auto shrink-0">
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
                    <span className="w-8 tabular-nums text-right">
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
                    <span className="w-8 tabular-nums text-right">
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
                      value={activeResume.globalSettings?.pagePadding || 32}
                      onChange={(e) =>
                        updateGlobalSettings({
                          pagePadding: Number(e.target.value),
                        })
                      }
                      className="w-20 accent-primary"
                    />
                    <span className="w-8 tabular-nums text-right">
                      {activeResume.globalSettings?.pagePadding || 32}
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
                    <span className="w-8 tabular-nums text-right">
                      {moduleSpacing}
                    </span>
                  </label>

                  {/* 保存按钮：与主题/排版设置归为一组，置于预览工具栏右端 */}
                  <div className="flex items-center gap-2 pl-3 ml-1 border-l border-border">
                    {savedAt && !saving && (
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                        已保存 {savedAt}
                      </span>
                    )}
                    <TooltipProvider delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7"
                            onClick={handleSave}
                            disabled={saving || !isDirty}
                          >
                            {saving ? (
                              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            {saving ? "保存中…" : "保存"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          {isDirty ? t("saveHint") : "内容未改动，无需保存"}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                {/* 显式传入 activeResume：版式变体按 resume.templateId 解析，
                    用户在模板页选的版式在进入编辑器后才不会丢。 */}
                <MarkdownPreview
                  ref={previewRef}
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
