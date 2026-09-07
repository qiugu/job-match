/**
 * 导出 PDF / 浏览器打印时的通用分页规则。
 *
 * 目的与 MarkdownPreview 的块边界分页保持一致：页边界只落在块与块之间，
 * 不从段落/列表项/标题中间切断文本行。
 *
 * 通用性约束（重要）：这里**只能按 HTML 语义标签**命中元素，禁止绑定任何
 * 具体简历版式/模板/模块的 class（如 .mod-section、.mod-item-title 等）。
 * 否则换一套简历样式就会失效，分页问题又会以另一种形式复发。
 *
 * 适用范围：
 * - html2pdf 导出（pagebreak.mode 含 "css"，识别 break-inside / break-after）
 * - 浏览器打印（exportResumeToBrowserPrint）
 * 两条路径共用同一份规则，保证「预览所见 = 导出所得 = 打印所得」。
 *
 * 选择器根用 #resume-preview：导出/打印时克隆的就是这个节点，且它是克隆树里
 * 唯一的内容流根，因此规则对整个内容统一生效，不会只命中其中一页。
 */
export const PAGE_BREAK_CSS = `
  #resume-preview p,
  #resume-preview li,
  #resume-preview h1,
  #resume-preview h2,
  #resume-preview h3,
  #resume-preview h4,
  #resume-preview h5,
  #resume-preview h6,
  #resume-preview blockquote,
  #resume-preview pre,
  #resume-preview table,
  #resume-preview tr,
  #resume-preview img,
  #resume-preview figure,
  #resume-preview hr,
  #resume-preview section,
  #resume-preview article {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  /* 标题不要孤零零留在页尾：与它后面的首个内容块保持同页 */
  #resume-preview h1,
  #resume-preview h2,
  #resume-preview h3,
  #resume-preview h4,
  #resume-preview h5,
  #resume-preview h6 {
    break-after: avoid !important;
    page-break-after: avoid !important;
  }
`;
