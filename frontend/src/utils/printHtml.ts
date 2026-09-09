import { PAGE_BREAK_CSS } from "@/utils/pageBreakCss";

/**
 * 打印 / 服务端导出共用的「打印版 HTML」组装层。
 *
 * 单一事实源：浏览器打印（utils/print.ts 的 iframe）与服务端 PDF 导出
 * （utils/pdfExportServer.ts）都通过 buildPrintHtml 生成同一份 HTML——
 * 保证「打印所得 = 服务端导出所得」，分页规则与版式完全一致。
 *
 * HTML 内容为自包含文档：@font-face、应用全部样式、分页 CSS 全部内联，
 * 字体 URL 保持 root-relative（/fonts/...），由消费端决定解析目标：
 *   - 浏览器打印：iframe 文档继承父页 origin，直接解析；
 *   - 服务端导出：后端在渲染前注入 <base href="{字体源}/"> 指向可达的
 *     字体资源（见后端 services/pdf_export.py）。
 */

export interface BuildPrintHtmlOptions {
  /** #resume-preview 克隆并预处理后的 outerHTML（经 normalizePrintContent） */
  content: string;
  /** 页面内边距 px（GlobalSettings.pagePadding ?? DEFAULT_PAGE_PADDING） */
  pagePadding: number;
  /** 归一化后的 font-family 值（normalizeFontFamily 产物） */
  fontFamily: string;
  /** 所选字体的 @font-face CSS（getFontFaceCss 产物，root-relative url） */
  fontFaceCss?: string;
  /** 应用全部样式表序列化（collectDocumentCss 产物），可选——供无 DOM 环境注入 */
  contentCss?: string;
  /** 文档标题 */
  title?: string;
}

export const buildPrintHtml = ({
  content,
  pagePadding,
  fontFamily,
  fontFaceCss = "",
  contentCss = "",
  title = "Resume",
}: BuildPrintHtmlOptions): string => {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      ${fontFaceCss}

      @page {
        size: A4;
        margin: 0;
        padding: 0;
      }
      * {
        box-sizing: border-box;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        background: white !important;
        height: auto !important;
        overflow: visible !important;
      }
      body {
        font-family: ${fontFamily};
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      #resume-preview {
        margin: 0 !important;
        padding: ${pagePadding}px !important;
        -webkit-box-decoration-break: clone;
        box-decoration-break: clone;
        font-family: ${fontFamily} !important;
        background: white !important;
      }

      #print-content {
        width: 210mm;
        margin: 0 auto;
        padding: 0;
        background: white;
        box-shadow: none;
      }
      #print-content * {
        box-shadow: none !important;
      }

      #resume-preview .min-h-screen,
      #resume-preview .min-h-full,
      #resume-preview [style*="min-height"] {
        min-height: 0 !important;
      }

      .page-break-line {
        display: none;
      }

      /* 防御性：打印时拍平预览纸张包装层，不留白、不显页码 */
      [data-pdf-export-ignore] {
        margin: 0 !important;
        box-shadow: none !important;
        overflow: visible !important;
        height: auto !important;
        width: 100% !important;
      }

      /* 分页规则与浏览器打印共用同一份，按语义标签命中不绑定具体版式 */
      ${PAGE_BREAK_CSS}

      ${stripFontFaces(contentCss)}
    </style>
  </head>
  <body>
    <div id="print-content">
      ${content}
    </div>
  </body>
</html>`;
};

/**
 * 收集应用全部样式表序列化文本（打印 iframe 与服务端导出共用）。
 * 跨域样式表 cssRules 访问会抛错，逐表 try/catch 跳过。
 */
export const collectDocumentCss = (): string =>
  Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join("\n");
      } catch (e) {
        console.warn("Could not copy styles from sheet:", e);
        return "";
      }
    })
    .join("\n");

/**
 * 预处理导出内容克隆：把预览的 transform: scale(x) 转成 zoom 参与分页布局
 * 计算，并拍平 width/padding——让内容按 794px(A4@96dpi) 宽度流动分页。
 * 与浏览器打印共用同一套预处理，保证两通道版式一致。
 */
export const normalizePrintContent = (
  content: HTMLElement,
  fontFamily: string
): HTMLElement => {
  const transformValue = content.style.transform || "";
  const match = transformValue.match(/scale\(([\d.]+)\)/);
  if (match) {
    const scale = Number(match[1]);
    if (Number.isFinite(scale) && scale > 0 && scale < 1) {
      content.style.removeProperty("transform");
      content.style.removeProperty("transform-origin");
      content.style.setProperty("width", "100%");
      content.style.setProperty("zoom", String(scale));
    }
  }
  content.style.setProperty("font-family", fontFamily, "important");
  return content;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * 从收集到的应用样式表中剥离 @font-face 规则。
 *
 * 为什么：collectDocumentCss() 会把全局 font.css 的【全部】字体定义（11 款，
 * 多数为 8–10MB 的 TTF/OTF）一并收集进来。若这些字体被后端当作资源内联进
 * 渲染 HTML，体积会膨胀到百 MB 级，直接撑崩无头 Chromium（表现为导出请求
 * 永久 pending / TargetClosedError）。
 *
 * 当前字体已由 buildPrintHtml 的 fontFaceCss 参数单独提供，无需在 contentCss
 * 里重复引入全部字体定义——剥离后既保证字体正确，又避免体积爆炸。
 * 该剥离对浏览器打印路径同样安全（浏览器本就只加载实际用到的字体）。
 */
const stripFontFaces = (css: string): string =>
  css.replace(/\s*@font-face\s*\{[^}]*\}\s*/g, "");
