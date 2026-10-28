import React, { useCallback, useEffect, useRef, useState } from "react";
import { Eye, SlidersHorizontal, ChevronsLeft } from "lucide-react";
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
import { ThemeColorSwatches } from "@/components/editor/ThemeColorSwatches";
import { useLinkedScroll } from "@/hooks/useLinkedScroll";

interface MarkdownWorkbenchProps {
  previewPanelCollapsed: boolean;
  resumeContentRef: React.RefObject<HTMLDivElement>;
}

/**
 * 三栏宽度口径：左（排版设置）与预览按像素定档，中（编辑）吃剩余空间。
 *
 * 为什么用 px 而不是百分比：排版设置是一列固定密度的控件（标签 + 滑块 + 色板），
 * 内容宽度与视口无关。按 20% 分配时，1920px 屏会给它 384px（远超内容所需），
 * 编辑区被白白挤窄；设计稿的口径是 224px。这里换算成百分比喂给
 * react-resizable-panels（v2 只接受百分比），换算基准是实测的容器宽度，
 * 因此拖拽仍然自由、窄屏也不会溢出。
 */
const TYPESET_PANEL = {
  defaultPx: 224,
  minPx: 200,
  maxPx: 360,
};

/**
 * 收起后窄轨的宽度（百分比，不是像素）。
 *
 * react-resizable-panels 的 `collapsedSize` 只接受百分比，而且挂载后不再重读，
 * 所以这里不能按容器宽度折算 —— 折算值会被首帧的换算结果永久钉住。2.5% 在
 * 1600 视口正好是设计稿的 40px，1920 下是 48px、1280 下是 32px，都还容得下
 * 轨道里的 28px 图标按钮。
 */
const TYPESET_RAIL_PCT = 2.5;

/** 排版设置收起状态：跨会话记住用户的选择（关掉后不再默认铺开） */
const TYPESET_COLLAPSED_KEY = "jdmatch.workbench.typesetCollapsed";

/** 读取上次的收起偏好；localStorage 不可用（隐私模式）或 SSR 时退回「展开」 */
function readTypesetCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TYPESET_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 三栏面板头统一高度：三个面板的横向分隔线必须落在同一条基线上 */
const PANEL_BAR_HEIGHT = "h-[42px]";

// 主题色 → i18n 色名键（I9：色板不再把十六进制当可访问名）
const THEME_COLOR_KEYS: Record<string, string> = {
  "#1A1A1A": "ink",
  "#0047AB": "kleinBlue",
  "#2563EB": "brightBlue",
  "#8B0000": "deepRed",
  "#E8551F": "orange",
  "#4B0082": "indigo",
  "#2E8B57": "seaGreen",
};

// Markdown 编辑模式主布局：左为排版设置，中为 Markdown 编辑器，右为实时预览。
// 数据流：Markdown 源 -> 编辑器 -> store.markdownContent
//        -> 预览组件解析渲染（同时驱动 PDF 导出）。
const MarkdownWorkbench = ({
  previewPanelCollapsed,
  resumeContentRef,
}: MarkdownWorkbenchProps) => {
  const { activeResume, updateResume, setThemeColor, updateGlobalSettings } =
    useResumeStore();
  const t = useTranslations("markdownEditor");
  const tTheme = useTranslations("workbench.sidePanel.theme");
  const tTypo = useTranslations("workbench.sidePanel.typography");
  const tSpacing = useTranslations("workbench.sidePanel.spacing");
  const tColor = useTranslations("markdownEditor.colors");
  const previewPanelRef = useRef<ImperativePanelHandle>(null);
  const typesetPanelRef = useRef<ImperativePanelHandle>(null);
  // activeResume 就绪前组件整体 return null，面板未挂载、ref 为 null；
  // 若这期间用户切换了折叠态，collapse/expand 会静默丢失（旧版故障模式）。
  // 把就绪状态纳入依赖，确保面板挂载后立即同步当前折叠态。
  const resumeReady = !!activeResume;

  // —— 排版设置：可收起（旧版常驻 20% 宽度，既挤编辑区又无处关闭）——
  // 初值直接来自 localStorage，而不是「先用 false 渲染、再在 effect 里改」：
  // 本组件在 activeResume 就绪前整体返回 null，服务端与首帧客户端都没有可见
  // 输出，因此这里读 localStorage 不会产生水合不一致，也避免了一次
  // 「先铺开再收起」的闪烁与级联渲染（react-hooks/set-state-in-effect）。
  const [typesetCollapsed, setTypesetCollapsed] = useState(readTypesetCollapsed);

  const toggleTypesetPanel = useCallback(() => {
    setTypesetCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem(TYPESET_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 忽略存储失败：本次会话内仍然生效
      }
      return next;
    });
  }, []);

  // —— 像素档位 → 百分比：以实测容器宽度为基准 ——
  // 0 = 尚未测量。不要用 window.innerWidth 猜：容器宽度通常比视口窄，按猜出来
  // 的宽度折算百分比，会把 224px 档位整体放大一档（1920 屏实测涨到 268px）。
  const [groupWidth, setGroupWidth] = useState(0);
  // 左栏当前像素宽度：拖拽后回写，跨视口变化时用它把面板锁回同一个像素档。
  const [typesetPx, setTypesetPx] = useState(TYPESET_PANEL.defaultPx);

  /**
   * 容器宽度观察器必须用 **ref callback** 注册，不能用 `useEffect(() => …, [])`：
   * 本组件在 `activeResume` 就绪前整体 `return null`，首帧根本没有容器 DOM，
   * 那时挂上的 effect 只会拿到 null 并且再也不会重跑 —— groupWidth 永远是 0，
   * 一行折算代码都走不到（这正是「左栏在不同视口下按百分比漂移」的真因）。
   * ref callback 在节点真正插入/移除时才会被调用，天然对上挂载时机。
   */
  const groupObserverRef = useRef<ResizeObserver | null>(null);
  const attachGroupWrap = useCallback((el: HTMLDivElement | null) => {
    groupObserverRef.current?.disconnect();
    groupObserverRef.current = null;
    if (!el) return;
    setGroupWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // 同值不写回：窗口拖拽时 RO 每帧回调一次，无差别 setState 会把整棵树
      // 每帧重渲一遍（三栏里是 Tiptap 与预览，代价不小）。
      if (w > 0) setGroupWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    });
    ro.observe(el);
    groupObserverRef.current = ro;
  }, []);

  const pxToPct = useCallback(
    (px: number) =>
      groupWidth > 0 ? Math.min(90, Math.max(1, (px / groupWidth) * 100)) : 0,
    [groupWidth]
  );

  /**
   * 容器宽度变化后把左栏锁回像素档位。
   *
   * react-resizable-panels 只认百分比，而百分比是**相对值**：容器从 1600 变
   * 1920 时，同一份 14% 会静默把 224px 涨成 268px（实测），左栏看起来又
   * 「太大」了。这里在容器宽度或档位变化后重新折算并 resize 回去，做到
   * 「拖拽自由，换屏不漂」。
   */
  useEffect(() => {
    if (!groupWidth || typesetCollapsed) return;
    const clamped = Math.min(
      TYPESET_PANEL.maxPx,
      Math.max(TYPESET_PANEL.minPx, typesetPx)
    );
    typesetPanelRef.current?.resize(pxToPct(clamped));
  }, [groupWidth, typesetPx, typesetCollapsed, pxToPct]);

  /**
   * 面板尺寸变化（拖拽 / 程序化 resize）→ 回写像素档位，并把越界尺寸拉回。
   *
   * `minSize` / `maxSize` 只能给百分比（挂载时读取，无法随容器宽度更新），
   * 所以 200–360px 的硬约束必须在这里补：越过边界立即 resize 回去。收起态
   * 直接短路，否则 40px 级的窄轨会被当成「太窄」拉回 200px。
   */
  const handleTypesetResize = useCallback(
    (sizePct: number) => {
      if (!groupWidth || typesetCollapsed) return;
      const px = Math.round((sizePct / 100) * groupWidth);
      if (px < TYPESET_PANEL.minPx) {
        typesetPanelRef.current?.resize(pxToPct(TYPESET_PANEL.minPx));
        return;
      }
      if (px > TYPESET_PANEL.maxPx) {
        typesetPanelRef.current?.resize(pxToPct(TYPESET_PANEL.maxPx));
        return;
      }
      setTypesetPx((prev) => (Math.abs(prev - px) <= 2 ? prev : px));
    },
    [groupWidth, typesetCollapsed, pxToPct]
  );

  /**
   * 三栏百分比。
   *
   * react-resizable-panels **会按 100 归一化** `defaultSize`：三个面板只写
   * 11.67 / 32 / 48（合计 91.67）时，实际落位是 12.73% —— 224px 的栏位
   * 会变成 243px（1920 视口实测偏差 19px）。
   * 因此左栏按像素定档后，剩余空间再按 40:60 分给编辑区与预览，
   * 三者之和恒为 100，像素口径才真正生效。
   */
  const typesetPct = typesetPx && groupWidth > 0 ? pxToPct(typesetPx) : 14;
  const restPct = 100 - typesetPct;
  const editorPct = restPct * 0.4;
  const previewPct = restPct * 0.6;

  // —— 编辑区 ↔ 预览 滚动同步 ——
  const [editorScrollEl, setEditorScrollEl] = useState<HTMLDivElement | null>(null);
  const [previewScrollEl, setPreviewScrollEl] = useState<HTMLDivElement | null>(null);
  useLinkedScroll(editorScrollEl, previewScrollEl, !previewPanelCollapsed);

  useEffect(() => {
    // 面板与 PanelGroup 可能同帧挂载（activeResume 刚就绪的瞬间）：此时 Group
    // 的内部布局尚未初始化完毕，同帧调用 collapse 会读到未就绪状态而静默失败
    // （表现为「状态显示已收起、面板却没收起」——旧版故障模式）。
    // 延后一帧，确保 Group 完成初始化后再同步折叠态。
    const raf = requestAnimationFrame(() => {
      if (typesetCollapsed) {
        typesetPanelRef.current?.collapse();
      } else {
        typesetPanelRef.current?.expand();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [typesetCollapsed, resumeReady]);

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

  // 主题色自动落库已上提到 store（setThemeColor 内部 600ms 防抖后落库，I1），
  // 这里只负责更新状态，避免「组件层 + store 层」各存一份自动保存逻辑。
  const handleThemeColorChange = (color: string) => {
    setThemeColor(color);
  };

  // 预览缩放档位（I4）：默认「适配宽度」，窄笔电视口也能一眼看全整页。
  const [previewZoom, setPreviewZoom] = useState<"fit" | 0.75 | 1>("fit");

  const fontOptions = getFontOptions((key) => tTypo(`font.${key}`));

  if (!activeResume) return null;

  const themeColor = activeResume?.globalSettings?.themeColor || THEME_COLORS[0];
  // 字体 seg：映射既有 globalSettings.fontFamily（与 SidePanel/预览渲染同一口径）
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

  // 面板头：三栏共用一套语法（高度、内边距、分隔线），保证横向分隔线对齐。
  // 左栏底色是 paper-2（控件区），中/右是 card（编辑与预览的内容面）。
  const typesetBarClass = cn(
    "flex shrink-0 items-center gap-2 px-3",
    PANEL_BAR_HEIGHT,
    "bg-paper-2 border-b border-line"
  );

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <div className="flex-1 min-h-0" ref={attachGroupWrap}>
        <ResizablePanelGroup direction="horizontal" className="h-full min-h-0">
          {/* 左：排版设置（224px 档 · 可收起为窄轨） */}
          <ResizablePanel
            ref={typesetPanelRef}
            id="typeset-panel"
            order={1}
            defaultSize={typesetPct}
            // minSize / maxSize 只用**宽松常量**兜底，不要按容器宽度折算：
            // react-resizable-panels 只在挂载时读取这两个约束（实测不会随 props
            // 更新），而挂载首帧容器宽度还是 0，折算出来会把面板永久钉死在错误
            // 的百分比上（1920 屏实测被钉成 115px）。真正的 200–360px 像素约束
            // 由 handleTypesetResize + resize effect 负责。
            minSize={4}
            maxSize={40}
            collapsible
            collapsedSize={TYPESET_RAIL_PCT}
            onResize={handleTypesetResize}
            className="min-h-0 bg-paper-2 border-r border-line"
          >
            {typesetCollapsed ? (
              // 收起态：保留一条 40px 窄轨作为回收入口，而不是彻底消失。
              // 窄轨同样保留 42px 头行（含 border-b），否则三栏的横向分隔线会在
              // 左栏断开一截，反倒比展开时更不齐。
              <div data-panel="typeset" className="flex h-full flex-col items-center">
                <div
                  data-bar="typeset"
                  className={cn(typesetBarClass, "w-full justify-center gap-0 px-0")}
                >
                  <button
                    type="button"
                    onClick={toggleTypesetPanel}
                    aria-label={t("typeset.expandPanel")}
                    title={t("typeset.expandPanel")}
                    className={cn(
                      "grid h-7 w-7 place-items-center rounded-md text-ink-2",
                      "transition-colors hover:bg-paper hover:text-ink",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40"
                    )}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span
                  className="mt-3 select-none text-[10.5px] font-semibold leading-none text-ink-3"
                  style={{ writingMode: "vertical-rl" }}
                >
                  {t("typeset.title")}
                </span>
              </div>
            ) : (
              <div data-panel="typeset" className="flex h-full min-h-0 flex-col">
                {/* set__top：面板标题 + auto-save eyebrow + 收起 */}
                <div data-bar="typeset" className={typesetBarClass}>
                  <SlidersHorizontal className="w-3.5 h-3.5 shrink-0 text-ink-2" />
                  <b className="truncate text-xs font-semibold text-ink">
                    {t("typeset.title")}
                  </b>
                  <span className="ml-auto shrink-0 font-mono text-[9px] tracking-wider text-ink-3">
                    {t("typeset.autoSave")}
                  </span>
                  <button
                    type="button"
                    onClick={toggleTypesetPanel}
                    aria-label={t("typeset.collapsePanel")}
                    title={t("typeset.collapsePanel")}
                    className={cn(
                      "-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-ink-3",
                      "transition-colors hover:bg-paper hover:text-ink",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40"
                    )}
                  >
                    <ChevronsLeft className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {/* 字体：seg 按钮组（globalSettings.fontFamily） */}
                  <div className="px-4 pt-3.5">
                    <p className="text-[10.5px] font-semibold text-ink-3 mb-1.5">
                      {tTypo("font.title")}
                    </p>
                    {/* I9：字体选择是单选组，补 radiogroup / aria-checked，
                        让读屏器能读出当前选中项，而不是只靠背景色。 */}
                    <div
                      role="radiogroup"
                      aria-label={tTypo("font.title")}
                      className="grid grid-cols-2 gap-0.5 p-[3px] bg-paper border border-line rounded-lg"
                    >
                      {fontOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={selectedFont === option.value}
                          onClick={() =>
                            updateGlobalSettings({ fontFamily: option.value })
                          }
                          className={cn(
                            "h-6 rounded-md text-[11px] transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40",
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
                      aria-label={tTypo("baseFontSize.title")}
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
                      aria-label={tTypo("lineHeight.title")}
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
                      aria-label={tSpacing("pagePadding.title")}
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
                      aria-label={tSpacing("sectionSpacing.title")}
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
                    <ThemeColorSwatches
                      colors={THEME_COLORS}
                      value={themeColor}
                      onChange={handleThemeColorChange}
                      labelFor={(presetTheme) =>
                        THEME_COLOR_KEYS[presetTheme]
                          ? tColor(THEME_COLOR_KEYS[presetTheme])
                          : presetTheme
                      }
                    />
                  </div>
                </div>
              </div>
            )}
          </ResizablePanel>

          <ResizableHandle />

          {/* 中：Markdown 编辑。面板头就是富文本工具条本身——
              旧版在工具条上方又加了一条「Markdown 编辑」标题栏，两条同为
              bg-card，读作一条 77px 厚带，与右侧单条 42px 的预览头对不齐。 */}
          <ResizablePanel
            id="markdown-editor-panel"
            order={2}
            defaultSize={editorPct}
            minSize={22}
            className="min-h-0 bg-background"
          >
            <div data-panel="editor" className="h-full min-h-0">
              <MarkdownEditor
                value={activeResume.markdownContent ?? ""}
                onChange={handleChange}
                placeholder={t("placeholder")}
                fontFamily={selectedFont}
                baseFontSize={activeResume.globalSettings?.baseFontSize || 16}
                lineHeight={activeResume.globalSettings?.lineHeight || 1.5}
                onScrollContainer={setEditorScrollEl}
              />
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
            defaultSize={previewPct}
            minSize={25}
            className="min-h-0 bg-paper-2"
          >
            <div data-panel="preview" className="flex h-full min-h-0 flex-col">
              <div
                data-bar="preview"
                className={cn(
                  "flex shrink-0 items-center gap-2 px-3",
                  PANEL_BAR_HEIGHT,
                  "bg-card border-b border-line"
                )}
              >
                <Eye className="h-3.5 w-3.5 shrink-0 text-ink-2" />
                <p className="eb-zh truncate">{t("previewTitle")}</p>
                {/* I4/I15：用真实的缩放档位替换静态「A4」假控件，
                    窄视口默认「适配宽度」即可一眼看全整页。 */}
                <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-line p-[2px]">
                  {(["fit", 0.75, 1] as const).map((z) => (
                    <button
                      key={String(z)}
                      type="button"
                      aria-pressed={previewZoom === z}
                      onClick={() => setPreviewZoom(z)}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40",
                        previewZoom === z
                          ? "bg-ink text-paper"
                          : "text-ink-3 hover:bg-paper-2 hover:text-ink"
                      )}
                    >
                      {z === "fit"
                        ? t("previewZoom.fit")
                        : `${Math.round(z * 100)}%`}
                    </button>
                  ))}
                </div>
              </div>
              {/* I5：右侧预留 56px 安全区，让纸张（mx-auto 居中）始终落在
                  固定 dock 的左侧，不再出现「窗口变窄 / 页边距调小后 dock 压住正文」。 */}
              <div className="min-h-0 flex-1 pr-14">
                {/* 显式传入 activeResume：版式变体按 resume.templateId 解析，
                    用户在模板页选的版式在进入编辑器后才不会丢。 */}
                <MarkdownPreview
                  ref={resumeContentRef}
                  markdown={activeResume.markdownContent ?? ""}
                  resume={activeResume}
                  zoom={previewZoom}
                  onScrollContainer={setPreviewScrollEl}
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
