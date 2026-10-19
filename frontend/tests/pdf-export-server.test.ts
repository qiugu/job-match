import { describe, expect, it } from "vitest";
import { PDF_EXPORT_PHASES } from "@/utils/pdfExportServer";

describe("服务端 PDF 导出阶段契约", () => {
  it("按用户可理解的顺序暴露准备、生成、下载三个阶段", () => {
    expect(PDF_EXPORT_PHASES).toEqual([
      "preparing",
      "generating",
      "downloading",
    ]);
  });
});
