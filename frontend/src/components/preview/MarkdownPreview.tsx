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
import type { ResumeData } from "@/types/resume";
import type { MarkdownTemplateVariant } from "@/config/markdownTemplates";
import { buildVariantCss, resolveMarkdownVariant } from "./markdownVariants";

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
  // 解析为普通段落。这里把"包含（yyyy-mm..."格式的段落拆出来当子标题。
  out = out.replace(
    /<p>((?:[^\n<·]{2,40}?[·][^\n<]{2,40}?[（][^）\n<]{2,40}?[）][\s\S]*?))<\/p>/g,
    (_m, inner) => {
      // 仅当段落核心是「公司 · 角色（日期）」结构才拆
      if (RE_MOD_SUBTITLE.test(inner.trim())) {
        return `<div class="mod-item-title">${inner.trim()}</div>`;
      }
      return `<p>${inner}</p>`;
    }
  );

  // B. 第一行姓名|职位：把"毕友佳 | AI全栈开发"识别为整篇 H1 标题
  // 兼容「-」分隔（LLM 偶尔输出「姓名 - 方向」而非「姓名 | 方向」）
  out = out.replace(
    /<p>([^\n<|]{2,30}\s[|－-]\s[^\n<|]{2,40})<\/p>/,
    `<div class="mod-title-first-h1">$1</div>`
  );

  // B2. 姓名标题区整体居中：把「姓名 H1」与其后紧跟的个人信息段落（性别/电话/邮箱行）
  // 包进 md-align-center。简历姓名区常见居中排版，且 LLM 自由写的 :::center 不可靠，
  // 这里用确定性规则保证居中，不依赖模型输出。
  out = out.replace(
    /(<div class="mod-title-first-h1">[\s\S]*?<\/div>)\s*(<p>[\s\S]*?<\/p>)?/,
    (_m, h1, info) => {
      const infoPart = info || "";
      return `<div class="md-align-center resume-name-block">${h1}${infoPart}</div>`;
    }
  );

  // C. 【xxx】独立段落（模块标题）：把后续所有兄弟段落/列表包成 section
  out = out.replace(
    /<p>【([^】]+)】<\/p>([\s\S]*?)(?=<p>【|<div class="mod-title-first-h1">|$)/g,
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

  return out;
}

// 给正规 Markdown 模板简历补充结构性 class，让版式变体可以按「头部 / 技能区 / 经历区」
// 做更丰富的布局（顶部色带、技能标签、侧边栏等），而不只是改 h2 边框。
const SKILL_SECTION_TITLES = ["专业技能", "技能", "Skills", "Technical Skills"];
const SKILL_TITLE_PATTERN = SKILL_SECTION_TITLES.join("|");

function enhanceTemplateSections(srcHtml: string): string {
  if (!srcHtml) return srcHtml;
  let out = srcHtml;

  // A. 简历头部：第一个 h1 + 紧随的个人信息段落（中间可能隔着副标题 h2/strong），
  //    包进 .resume-header，便于按模板定义顶部样式。
  out = out.replace(
    /^(<h1[^>]*>[\s\S]*?<\/h1>[\s\S]{0,300}?<p[^>]*>[\s\S]*?<\/p>)/,
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

// 预览用 A4 纸张：把 #resume-preview 的长内容按每页高度裁切显示，
// 纸张之间留出空白（margin-bottom），底部显示页码。
// 仅用于编辑预览；导出 PDF 时这些包装层不在导出 DOM 中（export.ts 克隆的是
// #resume-preview 本身），且带 data-pdf-export-ignore 标记，导出/打印样式会将其拍平。
const MM_TO_PX = 3.78;
const A4_HEIGHT_PX = 297 * MM_TO_PX;

const PageSheet = React.memo(
  ({
    pageNumber,
    pageCount,
    sheetHeightPx,
    pagePadding,
    children,
  }: {
    pageNumber: number;
    pageCount: number;
    sheetHeightPx: number;
    pagePadding: number;
    children?: React.ReactNode;
  }) => {
    // 第 1 页直接承载 #resume-preview 内容；
    // 其余页用 overflow:hidden + 负 margin-top 偏移，显示对应页的内容片段。
    const offset = (pageNumber - 1) * sheetHeightPx;
    const isFirst = pageNumber === 1;

    return (
      <div
        data-pdf-export-ignore
        className="md-page-sheet relative bg-white shadow-lg overflow-hidden"
        style={{
          width: "210mm",
          height: `${sheetHeightPx}px`,
          marginBottom: pageNumber < pageCount ? "16px" : 0,
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            marginTop: isFirst ? 0 : -offset,
          }}
        >
          {children}
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
// 容器保留 id="resume-preview"，以便复用既有 exportToPdf（Playwright 服务端导出）。
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
    const pagePadding = settings?.pagePadding || 32;
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

    // 真实内容高度测量：使用独立的隐藏测量节点（measureRef），
    // 不裁切、不设 minHeight，避免显示副本的 minHeight/overflow 干扰 → 页数真实反映内容。
    const [contentHeight, setContentHeight] = useState(0);
    const measureRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const el = measureRef.current;
      if (!el) return;

      const update = () => {
        const height = el.scrollHeight;
        if (height > 0) {
          setContentHeight((prev) => (prev !== height ? height : prev));
        }
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
    }, [markdown, pagePadding, fontFamily, baseFontSize, lineHeight]);

    // 分页计算：每页 = 一张 A4 纸（总高 A4_HEIGHT_PX），与 Puppeteer PDF 导出一致。
    // 页面按整张 A4 高度向下切分（PageSheet 通过负 margin-top 偏移显示对应片段），
    // padding 只存在于内容首尾各一次，因此页数 = 内容总高（含首尾 padding）/ A4 高，向上取整。
    // 注意不能按「内容区高度 / (A4 - 2*padding)」计算——那相当于每页都重复扣减 padding，
    // 当内容高度恰好落在 (k-1)*A4+2P 与 k*A4 之间时会多算一页，渲染出没有任何内容的空白页。
    const { pageCount, sheetHeightPx } = useMemo(() => {
      if (contentHeight <= 0) {
        return { pageCount: 1, sheetHeightPx: A4_HEIGHT_PX };
      }

      let count = Math.max(1, Math.ceil(contentHeight / A4_HEIGHT_PX));
      // 兜底：若末页偏移起点已超出实际内容高度（如测量误差导致页数偏大），
      // 回收该空白页，保证最后一页一定有内容、页码与实际渲染页数一致
      while (count > 1 && (count - 1) * A4_HEIGHT_PX >= contentHeight) {
        count -= 1;
      }
      return { pageCount: count, sheetHeightPx: A4_HEIGHT_PX };
    }, [contentHeight, pagePadding]);

    if (!activeResume) {
      // 允许在「无激活简历」上下文中渲染（如仪表盘缩略卡片）：
      // settings 已回退到默认值，markdown 仍可由 props 传入。
    }

    return (
      <div
        className={cn(
          "h-full min-h-0 overflow-y-auto",
          embedded ? "bg-white" : "bg-gray-100 py-4"
        )}
      >
        {/* 隐藏测量节点：渲染完整内容，仅用于测量真实高度（不裁切、无 minHeight），保证页数真实。
            必须带上 resume-markdown-preview 类，否则内部 h1/h2/p/ul 等不应用简历样式，测量高度会远小于真实显示高度，
            导致 pageCount 算少、末尾内容被截断。 */}
        <div
          ref={measureRef}
          aria-hidden
          className="resume-markdown-preview"
          data-preview-id={previewId}
          style={{
            position: "absolute",
            left: "-99999px",
            top: 0,
            width: "210mm",
            padding: `${pagePadding}px`,
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
          {Array.from({ length: pageCount }, (_, i) => {
            const pageNumber = i + 1;
            const isFirst = pageNumber === 1;
            return (
              <PageSheet
                key={`page-${pageNumber}`}
                pageNumber={pageNumber}
                pageCount={pageCount}
                sheetHeightPx={sheetHeightPx}
                pagePadding={pagePadding}
              >
                <div
                  ref={isFirst ? previewRef : undefined}
                  id={isFirst ? "resume-preview" : undefined}
                  className="resume-markdown-preview relative bg-white"
                  data-preview-id={previewId}
                  style={{
                    fontFamily,
                    fontSize: `${baseFontSize}px`,
                    lineHeight,
                    padding: `${pagePadding}px`,
                    color: "#1a1a1a",
                    boxSizing: "border-box",
                    minHeight: `${sheetHeightPx}px`,
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
          .resume-markdown-preview .mod-title-first-h1 {
            font-size: ${headerSize + 6}px;
            font-weight: 700;
            color: var(--resume-theme);
            line-height: 1.2;
            margin-bottom: ${Math.round(lineUnit * 0.5)}px;
          }
          /* 姓名区整体居中：姓名 H1 与个人信息行统一居中排版 */
          .resume-markdown-preview .resume-name-block {
            text-align: center;
            margin-bottom: ${Math.round(lineUnit * 0.5)}px;
          }
          .resume-markdown-preview .resume-name-block .mod-title-first-h1 {
            margin-bottom: ${Math.round(lineUnit * 0.15)}px;
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
          .resume-markdown-preview a {
            color: var(--resume-theme);
            text-decoration: none;
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

          /* 单行内联容器：用于同一行左右分布（如 学校 | 日期） */
          .resume-markdown-preview p:has(> .md-align-left):has(> .md-align-right),
          .resume-markdown-preview p:has(> .md-align-right):has(> .md-align-left) {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
          }
          .resume-markdown-preview p:has(> .md-align-left):not(:has(> .md-align-right)) {
            display: flex;
            justify-content: flex-start;
            align-items: baseline;
          }
          .resume-markdown-preview p:has(> .md-align-right):not(:has(> .md-align-left)) {
            display: flex;
            justify-content: flex-end;
            align-items: baseline;
          }
          .resume-markdown-preview p:has(> .md-align-center) {
            display: flex;
            justify-content: center;
            align-items: baseline;
          }
          .resume-markdown-preview p > .md-align-left,
          .resume-markdown-preview p > .md-align-right,
          .resume-markdown-preview p > .md-align-center {
            display: inline;
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
