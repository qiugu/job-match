
import React, { useEffect, useMemo, useState, useRef } from "react";
import throttle from "lodash/throttle";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { cn } from "@/lib/utils";
import { useResumeStore } from "@/store/useResumeStore";
import { normalizeFontFamily } from "@/utils/fonts";
import { DEFAULT_PAGE_PADDING } from "@/types/resume";
import ResumeTemplateComponent from "../templates";

interface PreviewPanelProps {
  sidePanelCollapsed: boolean;
  editPanelCollapsed: boolean;
  previewPanelCollapsed: boolean;
  toggleSidePanel: () => void;
  toggleEditPanel: () => void;
  togglePreviewPanel: () => void;
}

const PageBreakLine = React.memo(
  ({
    pageNumber,
    contentPerPagePx,
    pagePadding,
  }: {
    pageNumber: number;
    contentPerPagePx: number;
    pagePadding: number;
  }) => {
    // 预览中 #resume-preview 有 padding-top，内容从 pagePadding 位置开始
    // 每页能容纳 contentPerPagePx 高度的内容（与 Puppeteer PDF margin 一致）
    // 第 N 页结束位置 = pagePadding + N * contentPerPagePx
    const top = pagePadding + pageNumber * contentPerPagePx;

    return (
      <div
        className="absolute left-0 right-0 pointer-events-none page-break-line"
        style={{ top: `${top}px` }}
      >
        <div className="relative w-full">
          <div className="absolute w-full border-t-2 border-dashed border-danger" />
          <div className="absolute right-0 -top-6 text-xs text-danger">
            第{pageNumber}页结束
          </div>
        </div>
      </div>
    );
  }
);

PageBreakLine.displayName = "PageBreakLine";

const PreviewPanel = React.forwardRef<HTMLDivElement, PreviewPanelProps>(
  (
    {
      sidePanelCollapsed,
      editPanelCollapsed,
      previewPanelCollapsed,
      toggleSidePanel,
      toggleEditPanel,
      togglePreviewPanel,
    },
    ref
  ) => {
    const { activeResume, setActiveSection } = useResumeStore();
    const selectedFontFamily = normalizeFontFamily(
      activeResume?.globalSettings?.fontFamily
    );
    const template = useMemo(() => {
      return (
        DEFAULT_TEMPLATES.find((t) => t.id === activeResume?.templateId) ||
        DEFAULT_TEMPLATES[0]
      );
    }, [activeResume?.templateId]);

    const startRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const internalResumeContentRef = useRef<HTMLDivElement>(null);
    const resumeContentRef = (ref as React.MutableRefObject<HTMLDivElement>) || internalResumeContentRef;
    const [contentHeight, setContentHeight] = useState(0);

    const updateContentHeight = () => {
      if (resumeContentRef.current) {
        const height = resumeContentRef.current.clientHeight;
        if (height > 0) {
          if (height !== contentHeight) {
            setContentHeight(height);
          }
        }
      }
    };

    useEffect(() => {
      const debouncedUpdate = throttle(() => {
        requestAnimationFrame(() => {
          updateContentHeight();
        });
      }, 100);

      const observer = new MutationObserver(debouncedUpdate);

      if (resumeContentRef.current) {
        observer.observe(resumeContentRef.current, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });

        updateContentHeight();
      }

      const resizeObserver = new ResizeObserver(debouncedUpdate);

      if (resumeContentRef.current) {
        resizeObserver.observe(resumeContentRef.current);
      }

      return () => {
        observer.disconnect();
        resizeObserver.disconnect();
      };
    }, []);

    useEffect(() => {
      if (activeResume) {
        const timer = setTimeout(updateContentHeight, 300);
        return () => clearTimeout(timer);
      }
    }, [activeResume]);

    const pagePadding = activeResume?.globalSettings?.pagePadding ?? DEFAULT_PAGE_PADDING;

    const { contentPerPagePx, pageBreakCount } = useMemo(() => {
      const MM_TO_PX = 3.78;
      const A4_HEIGHT_PX = 297 * MM_TO_PX;

      // 与 Puppeteer PDF 导出一致：margin: pagePadding px（上下各一份）
      // 每页可用内容高度 = A4 总高度 - 上 margin - 下 margin
      const contentPerPage = A4_HEIGHT_PX - 2 * pagePadding;

      // contentHeight 包含 #resume-preview 的 padding（上+下）
      // 实际内容高度 = contentHeight - 2 * pagePadding
      const actualContentHeight = contentHeight - 2 * pagePadding;
      const pageCount = Math.max(1, Math.ceil(actualContentHeight / contentPerPage));
      const pageBreakCount = Math.max(0, pageCount - 1);

      return { contentPerPagePx: contentPerPage, pageBreakCount };
    }, [contentHeight, pagePadding]);

    if (!activeResume) return null;

    const handlePreviewClickCapture = (
      event: React.MouseEvent<HTMLDivElement>
    ) => {
      const target = event.target as HTMLElement | null;
      const sectionElement = target?.closest<HTMLElement>(
        "[data-resume-section-id]"
      );
      const sectionId = sectionElement?.dataset.resumeSectionId;

      if (!sectionId || sectionId === activeResume.activeSection) {
        return;
      }

      setActiveSection(sectionId);
    };

    return (
      <div
        ref={previewRef}
        className="relative w-full h-full  bg-muted"
        style={{
          fontFamily: selectedFontFamily,
        }}
      >
        <div className="py-4 ml-4 px-4 min-h-screen flex justify-center scale-[58%] origin-top md:scale-90 md:origin-top-left">
          <div
            ref={startRef}
            className={cn(
              "w-[210mm] min-w-[210mm] min-h-[297mm]",
              "bg-white",
              "shadow-lg",
              "relative mx-auto"
            )}
          >
            <div
              ref={resumeContentRef}
              id="resume-preview"
              onClickCapture={handlePreviewClickCapture}
              style={{
                fontFamily: selectedFontFamily,
                // 复用上方归一化的 pagePadding（缺失时回退 DEFAULT_PAGE_PADDING），
                // 保证实际渲染边距与分页数学同口径。
                padding: `${pagePadding}px`,
              }}
              // 保留 resume-preview class：排版规则统一按 class 生效（#resume-preview
              // id 只作为导出/打印的 DOM 句柄，不参与样式匹配）。
              className="relative resume-preview"
            >
              <style>{`
              .grammar-error {
                cursor: help;
                border-bottom: 2px dashed;
                transition: background-color 0.2s ease;
              }

              .grammar-error.spelling {
                border-color: #ef4444;
              }

              .grammar-error.grammar {
                border-color: #f59e0b;
              }

              .grammar-error:hover {
                background-color: rgba(239, 68, 68, 0.1);
              }

              /* 使用属性选择器匹配所有active-*类 */
              .grammar-error[class*="active-"] {
                animation: highlight 2s ease-in-out;
              }

              @keyframes highlight {
                0% {
                  background-color: transparent;
                }
                20% {
                  background-color: rgba(239, 68, 68, 0.2);
                }
                80% {
                  background-color: rgba(239, 68, 68, 0.2);
                }
                100% {
                  background-color: transparent;
                }
              }
              `}</style>
              <ResumeTemplateComponent data={activeResume} template={template} />
              {contentHeight > 0 && (
                <>
                  <div key={`page-breaks-container-${contentHeight}`}>
                    {Array.from(
                      { length: Math.min(pageBreakCount, 20) },
                      (_, i) => {
                        const pageNumber = i + 1;

                        const pageLinePosition =
                          pagePadding + pageNumber * contentPerPagePx;

                        if (pageLinePosition <= contentHeight) {
                          return (
                            <PageBreakLine
                              key={`page-break-${pageNumber}`}
                              pageNumber={pageNumber}
                              contentPerPagePx={contentPerPagePx}
                              pagePadding={pagePadding}
                            />
                          );
                        }
                        return null;
                      }
                    ).filter(Boolean)}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  });

PreviewPanel.displayName = "PreviewPanel";

export default PreviewPanel;
