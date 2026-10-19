import { describe, expect, it } from "vitest";
import {
  PDF_EXPORT_PROGRESS,
  PDF_EXPORT_LAYOUTS,
  getPdfExportDisplayPhase,
  initialPdfExportState,
  pdfExportInteractionReducer,
} from "@/utils/pdfExportInteraction";

describe("PDF 导出交互状态", () => {
  it("成功完成后关闭弹框并回到空闲状态", () => {
    const openState = pdfExportInteractionReducer(initialPdfExportState, {
      type: "open",
    });
    const exportingState = pdfExportInteractionReducer(openState, {
      type: "start",
    });

    expect(
      pdfExportInteractionReducer(exportingState, {
        type: "finish",
        success: true,
      })
    ).toEqual({ isOpen: false, phase: "idle" });
  });

  it("失败后保留弹框，允许用户改用打印", () => {
    const openState = pdfExportInteractionReducer(initialPdfExportState, {
      type: "open",
    });
    const exportingState = pdfExportInteractionReducer(openState, {
      type: "start",
    });

    expect(
      pdfExportInteractionReducer(exportingState, {
        type: "finish",
        success: false,
      })
    ).toEqual({ isOpen: true, phase: "idle" });
  });

  it("导出阶段不能被关闭或重复提交", () => {
    const openState = pdfExportInteractionReducer(initialPdfExportState, {
      type: "open",
    });
    const exportingState = pdfExportInteractionReducer(openState, {
      type: "start",
    });

    expect(
      pdfExportInteractionReducer(exportingState, { type: "close" })
    ).toEqual(exportingState);
    expect(
      pdfExportInteractionReducer(exportingState, { type: "start" })
    ).toEqual(exportingState);
  });

  it("选择器和进度视图共用同一块固定高度，进度覆盖而不是撑开弹框", () => {
    expect(PDF_EXPORT_LAYOUTS.chooser.bodyHeight).toBe(
      PDF_EXPORT_LAYOUTS.progress.bodyHeight
    );
    expect(PDF_EXPORT_LAYOUTS.progress.statusPlacement).toBe("overlay");
  });

  it("不把几乎瞬时的准备阶段作为单独的用户进度", () => {
    expect(getPdfExportDisplayPhase("preparing")).toBe("generating");
    expect(getPdfExportDisplayPhase("generating")).toBe("generating");
    expect(getPdfExportDisplayPhase("downloading")).toBe("downloading");
  });

  it("未知耗时使用不确定进度，不伪造百分比", () => {
    expect(PDF_EXPORT_PROGRESS.mode).toBe("indeterminate");
    expect(PDF_EXPORT_PROGRESS.ariaValueNow).toBeUndefined();
  });
});
