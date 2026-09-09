import React, {
  useMemo,
  useRef,
  forwardRef,
  useEffect,
  useState,
} from "react";
import throttle from "lodash/throttle";
import { useResumeStore } from "@/store/useResumeStore";
import { normalizeFontFamily } from "@/utils/fonts";
import { renderMarkdownToHtml } from "@/utils/markdownRender";
import { generateUUID } from "@/utils/uuid";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_PADDING, type ResumeData } from "@/types/resume";
import type { MarkdownTemplateVariant } from "@/config/markdownTemplates";
import { buildVariantCss, resolveMarkdownVariant } from "./markdownVariants";
import {
  A4_HEIGHT_PX,
  SHEET_GAP_PX,
  buildPageWindows,
  collectBlockMetrics,
  paginateBlocks,
  type BlockMetric,
} from "./pagination";

interface MarkdownPreviewProps {
  markdown: string;
  /** 嵌入式场景（如仪表盘缩略卡片）：去掉灰底与内边距，避免露出灰色间隙 */
  embedded?: boolean;
  /**
   * 指定渲染所用的简历数据。缩略图等「非当前编辑中」场景应传入各自简历，
   * 使其主题色/字体/行高等使用简历自身 globalSettings，而非全局激活简历的设置。
   * 不传时回退到 useResumeStore 的 activeResume（编辑器内预览保持原行为）。
   * 注意：版式变体只按显式传入的 resume.templateId 解析，不会取 activeResume，
   * 否则匹配结果页会错误套用当前编辑中简历的版式。
   */
  resume?: ResumeData;
  /**
   * 强制指定版式变体（模块标题/姓名标题/小标题的排版规则）。
   * 不传时按 resume.templateId 查模板；模板页缩略图即依赖这一路径。
   */
  variant?: MarkdownTemplateVariant;
}

// PDF 提取简历的【模块名】方括号标题后处理：
// 把形如 `<p>【教育经历】...</p>` 的段落重写成有视觉层级的结构，
// 否则 markdown-it 把【】当成普通文本，模块之间完全没有标题样式。
// 同时拆出 project/work 子标题（`公司 · 角色（日期）`）为 .mod-item-title。
const MODULE_TITLES = new Set([
  "教育经历", "工作经历", "项目经历", "工作经验", "项目经验",
  "技能", "专业技能", "个人技能", "获奖经历", "自我评价",
]);

const RE_MOD_H1 = /^([^|]{2,30}\|\s*[^\n<]{2,30})$/;
const RE_MOD_SUBTITLE = /^[^\n·]{2,40}[·][^\n（]{2,40}[（][^）\n]{2,40}[）]/;

// 把 markdown-it 输出的"【xxx】标题 + 后继段落/列表"重写为带视觉分层的结构；
// 同时识别"公司 · 角色（日期）"这类子标题、并把首行"姓名 | 职位"提升为 h1 视觉。
function enhanceBracketSections(srcHtml: string): string {
  if (!srcHtml) return srcHtml;
  let out = srcHtml;

  // A. 子标题（公司 · 角色（日期））：原 LLM 在工作/项目段内用 markdown 把
  // "上海爱数 · 平台方向负责人（2022-04 - 2026-05）"作为整段导出，被 markdown-it
  // 解析为普通段落。pymupdf4llm 还会把"子标题 + 正文"合并成同一段且包进
  // <strong>（如 `**字节跳动 · 高级工程师（2020-2023） 负责核心系统设计…**`），
  // 这里兼容 <strong> 包裹，并把"公司·角色（日期）"前缀拆为子标题、剩余
  // 正文作为独立段落，恢复层级与换行。
  out = out.replace(
    /<p>(?:<strong>)?((?:[^\n<·]{2,40}?[·][^\n<]{2,40}?[（][^）\n<]{2,40}?[）][\s\S]*?))(?:<\/strong>)?<\/p>/g,
    (_m, inner) => {
      const text = String(inner).replace(/<\/?strong>/g, "").trim();
      // 仅当段落以「公司 · 角色（日期）」结构开头才拆为子标题 + 正文
      const sub = text.match(RE_MOD_SUBTITLE);
      if (sub) {
        const title = sub[0].trim();
        const rest = text.slice(title.length).trim();
        if (rest) {
          return `<div class="mod-item-title">${title}</div><p>${rest}</p>`;
        }
        return `<div class="mod-item-title">${title}</div>`;
      }
      return `<p>${text}</p>`;
    }
  );

  // C. 【xxx】独立段落（模块标题）：把后续所有兄弟段落/列表包成 section
  out = out.replace(
    /<p>【([^】]+)】<\/p>([\s\S]*?)(?=<p>【|$)/g,
    (_m, name, body) => {
      const nm = String(name).trim();
      return `<section class="mod-section" data-mod="${nm}"><div class="mod-title">【${nm}】</div>${body}</section>`;
    }
  );

  // D. 同一段落内的【xxx】标题也拆出
  out = out.replace(
    /<p>【([^】]+)】([\s\S]*?)<\/p>/g,
    (_m, name, rest) => {
      const nm = String(name).trim();
      return `<section class="mod-section" data-mod="${nm}"><div class="mod-title">【${nm}】</div><p>${rest}</p></section>`;
    }
  );

  // E. 去除标题内冗余 <strong>：pymupdf4llm 会把 #/##/### 标题整体加粗
  // （如 `## **工作经历**`），嵌套 <strong> 不会改变字号但会让标题意外变重、
  // 与纯 CSS 控制的层级视觉不一致。去掉后标题层级由版式变体统一控制。
  out = out.replace(
    /<(h[1-3])>(?:<strong>)?([\s\S]*?)(?:<\/strong>)?<\/\1>/g,
    (_m, tag, inner) => `<${tag}>${String(inner).replace(/<\/?strong>/g, "")}</${tag}>`
  );

  return out;
}

// 给正规 Markdown 模板简历补充结构性 class，让版式变体可以按「头部 / 技能区 / 经历区」
// 做更丰富的布局（顶部色带、技能标签、侧边栏等），而不只是改 h2 边框。
const SKILL_SECTION_TITLES = ["专业技能", "技能", "Skills", "Technical Skills"];
const SKILL_TITLE_PATTERN = SKILL_SECTION_TITLES.join("|");

function enhanceTemplateSections(srcHtml: string): string {
  if (!srcHtml) return srcHtml;
  let out = srcHtml;

  // A. 简历头部：第一个 h1 + 紧随的个人信息段落（中间允许隔着副标题 h2、<br> 或纯文本），
  //    包进 .resume-header，便于按模板定义顶部样式。
  //    注意：中间段用排除法（[^<] | <br> | 单个 <h2>），绝不能吞入 <ul>/<section>/第二个 <p>
  //    等块级模块，否则会把头部下方的模块内容误包进 .resume-header，使其 margin-bottom
  //    错误地隔断本应连续的文本。
  out = out.replace(
    /^(<h1[^>]*>[\s\S]*?<\/h1>(?:<h2[^>]*>[\s\S]*?<\/h2>|<strong>[^<]*<\/strong>|<em>[^<]*<\/em>|<br\s*\/?>|[^<])*?<p[^>]*>[\s\S]*?<\/p>)/,
    '<div class="resume-header">$1</div>'
  );

  // B. 专业技能区：h2 + 后续 ul/table 内容包成 section.mod-skills，
  //    让创意/瑞士/极简等模板可以把技能渲染成标签、表格或紧凑行。
  const skillRegex = new RegExp(
    `(<h2[^>]*>(?:${SKILL_TITLE_PATTERN})<\\/h2>)([\\s\\S]*?)(?=<h2|$)`,
    "gi"
  );
  out = out.replace(
    skillRegex,
    '<section class="mod-section mod-skills">$1$2</section>'
  );

  return out;
}

// 预览用 A4 纸张：纸张之间留出空白（margin-bottom），底部显示页码。
// 仅用于编辑预览；导出 PDF 时这些包装层不在导出 DOM 中（export.ts 克隆的是
// #resume-preview 本身），且带 data-pdf-export-ignore 标记，导出/打印样式会将其拍平。
// 分页算法（页边距口径、块边界切分）见 ./pagination，保持为无 DOM 依赖的纯函数便于测试。

/** 块度量浅比较：测量结果未变化时复用旧对象，避免 ResizeObserver 触发无意义重渲染 */
function sameBlocks(a: BlockMetric[], b: BlockMetric[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.top === b[i].top && x.height === b[i].height);
}

/**
 * 内容流根节点的 class：测量副本与每一页显示副本必须完全一致。
 *
 * 这是分页正确性的前提：切点按「测量副本」的坐标计算，再用负 margin 套用到
 * 「显示副本」上。只要两者的 CSS 解析结果有任何差异（历史上就是全局样式
 * `#resume-preview ul/li` 只命中了带 id 的第一页副本），切点就会落在错误的内容
 * 位置上：上一页被挤出窗口、下一页又从更靠后的位置续接，中间那段内容在两页都
 * 看不见。因此这里统一复用同一个 class 常量，任何新增样式都必须同时作用于两者。
 *
 * 注意：`id="resume-preview"` 只挂在第一页显示副本上，作为 PDF 导出 / 打印 /
 * 语法检查的 DOM 句柄——全局样式禁止再按这个 id 命中元素（见 globals.css、
 * styles/tiptap.scss 中的约定注释）。
 */
const CONTENT_FLOW_CLASS = "resume-markdown-preview relative bg-white";

/** 参与「测量副本 vs 显示副本」一致性自检的布局相关属性（连字符写法） */
const LAYOUT_PROPS = [
  "display",
  "position",
  "box-sizing",
  "width",
  "margin-top",
  "margin-bottom",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-indent",
  "border-top-width",
  "border-bottom-width",
  "list-style-type",
  "list-style-position",
];

/** 逐元素对比两份副本的计算样式，返回前 limit 条差异（无差异返回空数组） */
function diffFlowStyles(a: HTMLElement, b: HTMLElement, limit = 5) {
  const out: Array<{
    index: number;
    tag: string;
    prop: string;
    measure: string;
    display: string;
  }> = [];
  const ea = Array.from(a.querySelectorAll<HTMLElement>("*"));
  const eb = Array.from(b.querySelectorAll<HTMLElement>("*"));
  if (ea.length !== eb.length) {
    out.push({
      index: -1,
      tag: "structure",
      prop: "elementCount",
      measure: String(ea.length),
      display: String(eb.length),
    });
  }
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n && out.length < limit; i++) {
    const ca = getComputedStyle(ea[i]);
    const cb = getComputedStyle(eb[i]);
    for (const p of LAYOUT_PROPS) {
      const va = ca.getPropertyValue(p);
      const vb = cb.getPropertyValue(p);
      if (va !== vb) {
        out.push({ index: i, tag: ea[i].tagName, prop: p, measure: va, display: vb });
        break;
      }
    }
  }
  return out;
}

const PageSheet = React.memo(
  ({
    pageNumber,
    pageCount,
    sheetHeightPx,
    pagePadding,
    windowHeightPx,
    contentOffsetPx,
    children,
  }: {
    pageNumber: number;
    pageCount: number;
    sheetHeightPx: number;
    pagePadding: number;
    /** 本页窗口高度（≤ 内容区高度）：块边界分页后，末段留白留在页底 */
    windowHeightPx: number;
    /** 本页内容在整体内容流中的起始 y，用负 margin-top 偏移到窗口顶部 */
    contentOffsetPx: number;
    children?: React.ReactNode;
  }) => {
    return (
      <div
        data-pdf-export-ignore
        className="md-page-sheet relative bg-white shadow-lg overflow-hidden"
        style={{
          width: "210mm",
          height: `${sheetHeightPx}px`,
          marginBottom: pageNumber < pageCount ? `${SHEET_GAP_PX}px` : 0,
          boxSizing: "border-box",
          overflow: "hidden",
          position: "relative",
          display: "block",
        }}
      >
        {/*
          页边距：每一页的上下左右都要留边，与 PDF 导出口径一致
          （打印/服务端导出共用 printHtml.ts：@page margin 0 + #resume-preview padding=pagePadding）。
          此前页边距只存在于整份内容的首尾，导致分页后上一页底部/下一页顶部贴着纸边，
          跨页处的文本行被硬切、看起来「掉进页间的间隙里」。
        */}
        <div
          style={{
            padding: `${pagePadding}px`,
            height: "100%",
            boxSizing: "border-box",
          }}
        >
          {/* 内容窗口：按本页实际内容高度裁切，块边界分页保证不会切断文本行 */}
          <div
            style={{
              height: `${windowHeightPx}px`,
              overflow: "hidden",
              position: "relative",
              display: "block",
            }}
          >
            <div
              style={{
                marginTop: `-${contentOffsetPx}px`,
                position: "relative",
                width: "100%",
              }}
            >
              {children}
            </div>
          </div>
        </div>

        {/* 底部页码：仅预览显示，导出 PDF 时不包含（data-pdf-export-ignore） */}
        <div
          className="absolute bottom-1 left-0 right-0 text-center text-xs text-gray-400 pointer-events-none select-none"
          style={{ paddingBottom: Math.max(2, pagePadding * 0.15) }}
        >
          {pageNumber} / {pageCount}
        </div>
      </div>
    );
  }
);

PageSheet.displayName = "MarkdownPageSheet";

// React Renderer：将 Markdown Parser 输出的 HTML 渲染为 A4 纸张上的简历。
// 容器保留 id="resume-preview"，供导出/打印克隆（pdfExportServer.ts / print.ts）。
const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  ({ markdown, embedded = false, resume, variant }, ref) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const previewRef = (ref as React.MutableRefObject<HTMLDivElement>) || internalRef;
    const previewIdRef = useRef<string>(`mdp-${generateUUID()}`);
    const previewId = previewIdRef.current;
    const { activeResume } = useResumeStore();
    // 传入 resume 时优先使用其 globalSettings（缩略图各自主题色）；
    // 未传则回退到当前编辑中的简历，保证编辑器内预览行为不变。
    const settings = resume?.globalSettings || activeResume?.globalSettings || {};

    const html = useMemo(() => renderMarkdownToHtml(markdown), [markdown]);

    // 【模块名】方括号标题检测：原简历是 PDF 提取产物，会带【教育经历】这种
    // 方括号标题（markdown 渲染器不识别），我们在这里后处理一次 html，把
    // 形如 `<p>【xxx】...</p>` 的段落拆出标题块，让模块保留视觉层级
    const enhancedHtml = useMemo(
      () => enhanceTemplateSections(enhanceBracketSections(html)),
      [html]
    );

    const fontFamily = normalizeFontFamily(settings?.fontFamily);
    const baseFontSize = settings?.baseFontSize || 16;
    const lineHeight = settings?.lineHeight || 1.5;
    // 一行文本的高度（px），标题间距以此为基准，随全局行高联动
    const lineUnit = Math.round(lineHeight * baseFontSize);
    const pagePadding = settings?.pagePadding ?? DEFAULT_PAGE_PADDING;
    const sectionSpacing = settings?.sectionSpacing || 10;
    // 模块间距：h2 顶级模块标题上方的留白。未设置时保持原有「半行高」观感
    // （随字号/行高联动、与历史渲染逐像素一致）；用户通过工具栏滑块显式
    // 设置 sectionSpacing 后，改用固定像素值，所见即所得。
    const moduleSpacing =
      settings?.sectionSpacing ?? Math.round(lineUnit * 0.5);
    const themeColor = settings?.themeColor || "#000000";
    const headerSize = settings?.headerSize || 22;
    const subheaderSize = settings?.subheaderSize || 17;
    // 版式变体：决定模块标题等标题的排版规则，是模板之间的核心视觉差异
    const activeVariant = resolveMarkdownVariant(resume, variant);
    const variantCss = buildVariantCss(
      activeVariant,
      {
        themeColor,
        headerSize,
        subheaderSize,
        lineUnit,
        moduleSpacing,
      },
      `.resume-markdown-preview[data-preview-id="${previewId}"]`
    );

    // 主题色变量，供渲染样式引用
    useEffect(() => {
      if (previewRef.current) {
        previewRef.current.style.setProperty("--resume-theme", themeColor);
      }
    }, [themeColor, previewRef]);

    // 真实内容测量：使用独立的隐藏测量节点（measureRef），
    // 不裁切、不设 minHeight、不设 padding，避免显示副本的窗口裁切干扰 → 页数真实反映内容。
    // 除了总高，还要采集「块度量」用于按块边界分页（见 paginateBlocks）。
    const [metrics, setMetrics] = useState<{
      height: number;
      blocks: BlockMetric[];
    }>({ height: 0, blocks: [] });
    const measureRef = useRef<HTMLDivElement>(null);
    // 每页可用内容高度 = A4 总高 - 上页边距 - 下页边距（与 PDF 导出口径一致）
    const contentAreaPx = Math.max(1, A4_HEIGHT_PX - 2 * pagePadding);

    useEffect(() => {
      const el = measureRef.current;
      if (!el) return;

      const update = () => {
        const height = el.scrollHeight;
        const blocks = collectBlockMetrics(el, contentAreaPx);
        setMetrics((prev) =>
          prev.height === height && sameBlocks(prev.blocks, blocks)
            ? prev
            : { height, blocks }
        );
      };

      update();

      const debounced = throttle(() => {
        requestAnimationFrame(update);
      }, 100);

      const resizeObserver = new ResizeObserver(debounced);
      resizeObserver.observe(el);

      // markdown 变化后下一帧再测一次，确保 innerHTML 已渲染
      const raf = requestAnimationFrame(update);

      // Web 字体加载完成后高度会变化，重测一次避免页数偏差导致末尾截断
      let cancelled = false;
      if (typeof document !== "undefined" && document.fonts?.ready) {
        document.fonts.ready.then(() => {
          if (!cancelled) update();
        });
      }

      return () => {
        cancelled = true;
        resizeObserver.disconnect();
        cancelAnimationFrame(raf);
      };
    }, [
      markdown,
      contentAreaPx,
      fontFamily,
      baseFontSize,
      lineHeight,
      sectionSpacing,
      moduleSpacing,
      headerSize,
      subheaderSize,
      variantCss,
    ]);

    // 分页计算：
    // 1) 每页可用内容高度 = A4 总高 - 上页边距 - 下页边距，与 PDF 导出
    //    （打印/服务端导出共用 printHtml.ts 的 @page + #resume-preview padding）口径一致，
    //    因此预览里每页的上下留白就是真实 PDF 的留白，所见即所得。
    // 2) 切点落在内容块的边界上（paginateBlocks），块放不下就整块推到下一页，
    //    不会把段落/列表项/标题从中间切断——这正是「文字落到页间间隙里看不见」的根因。
    // 3) 每页窗口高度 = 下一页起点 - 本页起点（上限为内容区高度），
    //    整块下推产生的留白就留在页底，不会出现没有任何内容的空白页。
    const pages = useMemo(() => {
      const cuts = paginateBlocks(metrics.blocks, contentAreaPx);
      return buildPageWindows(cuts, contentAreaPx, metrics.height);
    }, [metrics, contentAreaPx]);

    // 开发期不变量自检：测量副本与显示副本必须解析出完全相同的排版样式。
    // 切点按测量副本的坐标算、却要套用到显示副本上，两者一旦不一致，切点就会
    // 错位，表现为「分页处内容消失 / 被遮挡」——这类问题过去反复出现且极难定位，
    // 因此在这里直接对比两份副本的计算样式并报警（仅开发期、每个实例只报一次）。
    const divergenceWarnedRef = useRef(false);
    useEffect(() => {
      if (!import.meta.env.DEV || divergenceWarnedRef.current) return;
      const measureEl = measureRef.current;
      const displayEl = previewRef.current;
      if (!measureEl || !displayEl) return;
      const diffs = diffFlowStyles(measureEl, displayEl);
      if (diffs.length === 0) return;
      divergenceWarnedRef.current = true;
      console.warn(
        "[MarkdownPreview] 测量副本与显示副本的排版样式不一致，分页切点会错位（内容可能在分页处消失）。\n" +
          "常见原因：某个全局样式只命中其中一个副本（例如按 id=\"resume-preview\" 只命中第一页副本）。\n" +
          "measure = 测量副本，display = 显示副本：",
        diffs
      );
    }, [metrics, enhancedHtml, previewRef]);

    if (!activeResume) {
      // 允许在「无激活简历」上下文中渲染（如仪表盘缩略卡片）：
      // settings 已回退到默认值，markdown 仍可由 props 传入。
    }

    return (
      <div
        className={cn(
          "h-full min-h-0 overflow-y-auto",
          embedded ? "bg-muted py-4" : "bg-muted py-4"
        )}
      >
        {/* 隐藏测量节点：渲染完整内容，仅用于测量真实高度与块位置（不裁切、无 minHeight、无 padding），
            保证页数真实。
            必须带上 resume-markdown-preview 类，否则内部 h1/h2/p/ul 等不应用简历样式，测量高度会远小于真实显示高度，
            导致页数算少、末尾内容被截断。
            宽度必须与显示节点的内容区一致 = 纸张宽 - 左右页边距，否则换行位置不同 → 高度与块位置全部失真。 */}
        <div
          ref={measureRef}
          aria-hidden
          className={CONTENT_FLOW_CLASS}
          data-preview-id={previewId}
          style={{
            position: "absolute",
            left: "-99999px",
            top: 0,
            width: `calc(210mm - ${pagePadding * 2}px)`,
            fontFamily,
            fontSize: `${baseFontSize}px`,
            lineHeight,
            boxSizing: "border-box",
            visibility: "hidden",
            pointerEvents: "none",
            // 与 .resume-markdown-preview 样式共享主题色变量
            ["--resume-theme" as string]: themeColor,
          }}
          dangerouslySetInnerHTML={{ __html: enhancedHtml }}
        />
        <div className="mx-auto w-[210mm]">
          {pages.map((page, i) => {
            const pageNumber = i + 1;
            const isFirst = pageNumber === 1;
            return (
              <PageSheet
                key={`page-${pageNumber}`}
                pageNumber={pageNumber}
                pageCount={pages.length}
                sheetHeightPx={A4_HEIGHT_PX}
                pagePadding={pagePadding}
                windowHeightPx={page.windowHeight}
                contentOffsetPx={page.start}
              >
                <div
                  ref={isFirst ? previewRef : undefined}
                  id={isFirst ? "resume-preview" : undefined}
                  className={CONTENT_FLOW_CLASS}
                  data-preview-id={previewId}
                  style={{
                    fontFamily,
                    fontSize: `${baseFontSize}px`,
                    lineHeight,
                    // 页边距由 PageSheet 提供（每页都有），内容本身不再重复加 padding
                    color: "#1a1a1a",
                    boxSizing: "border-box",
                    ["--resume-theme" as string]: themeColor,
                  }}
                  dangerouslySetInnerHTML={{ __html: enhancedHtml }}
                />
              </PageSheet>
            );
          })}
        </div>

        {/* 渲染样式：仅在简历预览作用域内生效，避免污染全局 */}
        <style>{`
          .resume-markdown-preview {
            --resume-theme: ${themeColor};
          }
          /* PDF 提取简历的【模块名】方括号标题：升级为 h2 视觉样式。
             markdown-it 把不识别的【】文本当成普通文本，本组件需要为
             这类常见的 PDF 提取产物补一套结构化样式，否则一切都是
             普通段落，没有视觉分层。 */
          .resume-markdown-preview section.mod-section {
            display: block;
            margin: ${moduleSpacing}px 0 ${Math.round(lineUnit * 0.2)}px;
            padding-bottom: 4px;
            border-bottom: 2px solid var(--resume-theme);
          }
          .resume-markdown-preview section.mod-section > .mod-title {
            font-size: ${headerSize}px;
            font-weight: 700;
            color: var(--resume-theme);
            line-height: 1.25;
          }
          .resume-markdown-preview .mod-item-title {
            font-size: ${subheaderSize}px;
            font-weight: 600;
            color: var(--resume-theme);
            margin: ${Math.round(lineUnit * 0.25)}px 0 ${Math.round(lineUnit * 0.15)}px;
            line-height: 1.35;
          }
          /* 简历头部与技能区的默认结构样式：变体会在后面覆盖这些规则，
             实现顶部色带、技能标签、居中/左对齐等不同头部风格。 */
          .resume-markdown-preview .resume-header {
            margin-bottom: ${Math.round(lineUnit * 0.75)}px;
          }
          .resume-markdown-preview .resume-header h1 {
            margin: 0;
            line-height: 1.2;
          }
          .resume-markdown-preview .resume-header p {
            color: #555555;
            font-size: 0.95em;
            margin-top: ${Math.round(lineUnit * 0.2)}px;
          }
          .resume-markdown-preview .mod-skills {
            display: block;
          }
          .resume-markdown-preview .mod-skills > h2 {
            margin-top: 0;
          }
          /* 标题排版由「版式变体」决定：不同模板的模块标题/姓名标题样式不同，
             这是模板之间的核心视觉差异。变体来自 resume.templateId 或显式 variant 入参。 */
${variantCss}
          .resume-markdown-preview h2:first-child {
            margin-top: 0;
          }
          /* 文本间距统一由全局行高控制，段落/列表等块级元素不再额外撑开 margin */
          .resume-markdown-preview p {
            margin: 0;
          }
          .resume-markdown-preview ul,
          .resume-markdown-preview ol {
            margin: 0;
            padding-left: 1.4em;
          }
          /* Tailwind preflight 会重置列表标记，这里显式恢复，保证所有页面一致 */
          .resume-markdown-preview ul {
            list-style-type: disc;
            list-style-position: outside;
          }
          .resume-markdown-preview ul ul {
            list-style-type: circle;
          }
          .resume-markdown-preview ul ul ul {
            list-style-type: square;
          }
          .resume-markdown-preview ol {
            list-style-type: decimal;
            list-style-position: outside;
          }
          .resume-markdown-preview ol ol {
            list-style-type: lower-alpha;
          }
          .resume-markdown-preview ol ol ol {
            list-style-type: lower-roman;
          }
          .resume-markdown-preview li {
            margin: 0;
          }
          .resume-markdown-preview li > p {
            margin: 0;
          }
          .resume-markdown-preview strong {
            font-weight: 700;
          }
          .resume-markdown-preview blockquote {
            margin: 0;
            padding-left: 12px;
            border-left: 3px solid var(--resume-theme);
            color: #555;
          }
          .resume-markdown-preview code {
            background: #f3f4f6;
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 0.9em;
          }
          .resume-markdown-preview hr {
            border: none;
            border-top: 1px solid #e5e7eb;
            margin: ${sectionSpacing}px 0;
          }
          .resume-markdown-preview table {
            border-collapse: collapse;
            width: 100%;
            margin: 0;
            font-size: 0.95em;
          }
          .resume-markdown-preview th,
          .resume-markdown-preview td {
            border: 1px solid #e5e7eb;
            padding: 6px 8px;
            text-align: left;
          }
          .resume-markdown-preview img {
            max-width: 100%;
          }
          /* :::left / :::center / :::right 容器对齐 */
          /* 多行块容器：控制内部文本对齐 */
          .resume-markdown-preview div.md-align-left {
            text-align: left;
          }
          .resume-markdown-preview div.md-align-center {
            text-align: center;
          }
          .resume-markdown-preview div.md-align-right {
            text-align: right;
          }
          .resume-markdown-preview div.md-align-left > *,
          .resume-markdown-preview div.md-align-center > *,
          .resume-markdown-preview div.md-align-right > * {
            margin-left: 0;
            margin-right: 0;
          }
          .resume-markdown-preview div.md-align-center > ul,
          .resume-markdown-preview div.md-align-center > ol,
          .resume-markdown-preview div.md-align-right > ul,
          .resume-markdown-preview div.md-align-right > ol {
            list-style-position: inside;
          }

          /* 单行内联容器：用于同一行左右分布（如 学校 | 日期）。
             直接以 .md-align-inline-pair 类名定位，避免依赖 CSS :has()
             选择器（部分浏览器/环境下不生效，导致居左居右失效）。 */
          .resume-markdown-preview p.md-align-inline-pair {
            display: flex;
            align-items: baseline;
            gap: 1rem;
          }
          .resume-markdown-preview p.md-align-inline-pair > .md-align-left {
            flex: 1 1 auto;
            text-align: left;
          }
          .resume-markdown-preview p.md-align-inline-pair > .md-align-right {
            flex: 0 0 auto;
            text-align: right;
            white-space: nowrap;
          }
          .resume-markdown-preview p.md-align-inline-pair > .md-align-center {
            flex: 1 1 100%;
            text-align: center;
          }

          /* 多行块配对行：:::left 与紧随的 :::right 合并为同一行左右分布 */
          .resume-markdown-preview .md-pair-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 1rem;
            width: 100%;
          }
          .resume-markdown-preview .md-pair-row > div {
            flex: 0 1 auto;
            min-width: 0;
          }
          .resume-markdown-preview .md-pair-row > .md-align-left {
            text-align: left;
            flex: 1 1 auto;
          }
          .resume-markdown-preview .md-pair-row > .md-align-right {
            text-align: right;
            flex: 0 0 auto;
            white-space: nowrap;
          }
          .resume-markdown-preview .md-pair-row > div > *:first-child {
            margin-top: 0;
          }
          .resume-markdown-preview .md-pair-row > div > *:last-child {
            margin-bottom: 0;
          }
        `}</style>
      </div>
    );
  }
);

MarkdownPreview.displayName = "MarkdownPreview";

export default MarkdownPreview;
