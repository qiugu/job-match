import { toast } from "sonner";
import { getFontFaceCss, normalizeFontFamily } from "@/utils/fonts";
import { API_BASE } from "@/lib/apiBase";
import { authHeaders, handleUnauthorized } from "@/lib/auth";
import {
  buildPrintHtml,
  collectDocumentCss,
  normalizePrintContent,
} from "@/utils/printHtml";
import { normalizePagePadding } from "@/utils/pagePadding";

/**
 * 服务端 PDF 导出：把「打印版 HTML」（buildPrintHtml 产物）POST 给后端
 * /api/export/pdf，由服务端 headless Chromium 渲染为**矢量 PDF**。
 *
 * 与浏览器打印（print.ts）共用同一套 HTML 组装与内容预处理——打印所得 =
 * 导出所得。渲染在服务端完成：文字可选中/可搜索、ATS 友好、体积约 100–200KB。
 *
 * 失败处理：接口 5xx（渲染组件缺失/超时/限流）时抛出带 status 的 Error，
 * 调用方提示用户改用「浏览器打印 → 另存为 PDF」（无 html2pdf 降级）。
 */

const INVALID_FILE_NAME_CHAR_REGEX = /[\\/:*?"<>|]/g;

const getSafeFileName = (title?: string) => {
  const normalized = (title || "resume")
    .trim()
    .replace(INVALID_FILE_NAME_CHAR_REGEX, "_")
    .replace(/\s+/g, " ")
    .replace(/\.(pdf|json|md)$/i, "");
  return normalized || "resume";
};

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.URL.revokeObjectURL(url);
};

export interface ExportToServerPdfOptions {
  elementId: string;
  title: string;
  pagePadding: number;
  fontFamily?: string;
  onStart?: () => void;
  onEnd?: () => void;
  successMessage?: string;
  /** 非接口错误（如元素缺失）时的兜底提示 */
  errorMessage?: string;
}

export const exportToServerPdf = async ({
  elementId,
  title,
  pagePadding,
  fontFamily,
  onStart,
  onEnd,
  successMessage,
  errorMessage,
}: ExportToServerPdfOptions) => {
  onStart?.();
  try {
    const pdfElement = document.querySelector<HTMLElement>(`#${elementId}`);
    if (!pdfElement) {
      throw new Error(errorMessage || `Resume element #${elementId} not found`);
    }

    // 与 print.ts 完全一致的内容预处理 + HTML 组装
    const clonedElement = pdfElement.cloneNode(true) as HTMLElement;
    const selectedFontFamily = normalizeFontFamily(fontFamily);
    normalizePrintContent(clonedElement, selectedFontFamily);
    const fontFaceStyles = await getFontFaceCss(selectedFontFamily);
    const html = buildPrintHtml({
      content: clonedElement.outerHTML,
      pagePadding: normalizePagePadding(pagePadding),
      fontFamily: selectedFontFamily,
      fontFaceCss: fontFaceStyles,
      contentCss: collectDocumentCss(),
      title: title || "resume",
    });

    const res = await fetch(`${API_BASE}/api/export/pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        html,
        title: getSafeFileName(title),
      }),
    });
    if (res.status === 401) {
      handleUnauthorized();
    }
    if (!res.ok) {
      let detail = `导出失败 (${res.status})`;
      try {
        const body = await res.json();
        detail = body.detail || detail;
      } catch {
        /* ignore */
      }
      const error = new Error(detail) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }

    const blob = await res.blob();
    downloadBlob(blob, `${getSafeFileName(title)}.pdf`);

    if (res.headers.get("X-Font-Fallback") === "true") {
      toast.warning(
        "PDF 字体回退到系统字体，可能与预览不一致。请检查后端 PDF_EXPORT_FONT_ORIGIN 配置。"
      );
    } else if (successMessage) {
      toast.success(successMessage);
    }
  } catch (error) {
    console.error("Server PDF export error:", error);
    const message =
      error instanceof Error && error.message ? error.message : undefined;
    toast.error(message || errorMessage || "PDF 导出失败");
  } finally {
    onEnd?.();
  }
};
