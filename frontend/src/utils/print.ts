import { getFontFaceCss, normalizeFontFamily } from "@/utils/fonts";
import {
  buildPrintHtml,
  collectDocumentCss,
  normalizePrintContent,
} from "@/utils/printHtml";

export const exportResumeToBrowserPrint = async (
  resumeContent: HTMLElement,
  pagePadding: number,
  fontFamily?: string
) => {
  const printFrame = document.createElement("iframe");
  printFrame.style.position = "absolute";
  printFrame.style.width = "1px";
  printFrame.style.height = "1px";
  printFrame.style.left = "-9999px";
  printFrame.style.top = "0";
  printFrame.style.visibility = "hidden";
  printFrame.style.zIndex = "-1";
  document.body.appendChild(printFrame);

  const iframeWindow = printFrame.contentWindow;
  if (!iframeWindow) {
    console.error("IFrame window not found");
    document.body.removeChild(printFrame);
    return;
  }

  try {
    iframeWindow.document.open();

    const clonedContent = resumeContent.cloneNode(true) as HTMLElement;
    const selectedFontFamily = normalizeFontFamily(fontFamily);
    normalizePrintContent(clonedContent, selectedFontFamily);
    const fontFaceStyles = await getFontFaceCss(selectedFontFamily);

    const htmlContent = buildPrintHtml({
      content: clonedContent.outerHTML,
      pagePadding,
      fontFamily: selectedFontFamily,
      fontFaceCss: fontFaceStyles,
      contentCss: collectDocumentCss(),
      title: "Print Resume"
    });

    iframeWindow.document.write(htmlContent);
    iframeWindow.document.close();

    const printWhenReady = async () => {
      try {
        const doc = iframeWindow.document;

        // 等待字体加载
        if (doc.fonts?.ready) {
          await doc.fonts.ready;
        }

        // 等待所有图片加载完成
        const images = Array.from(doc.images);
        await Promise.all(
          images
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise<void>((resolve) => {
                  img.onload = () => resolve();
                  img.onerror = () => resolve();
                })
            )
        );

        // 给予额外的渲染帧缓冲
        await new Promise<void>((resolve) => {
          iframeWindow.requestAnimationFrame(() => {
            iframeWindow.requestAnimationFrame(() => resolve());
          });
        });

        iframeWindow.focus();
        iframeWindow.print();

        // 打印完成后清理iframe
        setTimeout(() => {
          if (document.body.contains(printFrame)) {
            document.body.removeChild(printFrame);
          }
        }, 1000);
      } catch (error) {
        console.error("Error print:", error);
        if (document.body.contains(printFrame)) {
          document.body.removeChild(printFrame);
        }
      }
    };

    void printWhenReady();
  } catch (error) {
    console.error("Error setting up print:", error);
    if (document.body.contains(printFrame)) {
      document.body.removeChild(printFrame);
    }
  }
};
