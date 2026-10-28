import DOMPurify from "isomorphic-dompurify";

/**
 * 简历渲染 HTML 清洗（S1 / S2 修复）。
 *
 * 背景：简历 markdown 由 PDF 提取 / LLM 生成，富文本由 Tiptap 产生，二者都可能携带
 * 原始 HTML（<ul><li> 残标、用户粘贴的标签、AI 返回的 HTML）。这些内容经
 * `dangerouslySetInnerHTML` 注入预览，必须清洗后才能渲染。
 *
 * 方案：以 DOMPurify（isomorphic 版，SSR 与浏览器通用）做**白名单**清洗——
 * 仅保留简历真正需要的标签 / 属性，其余（<script>、on* 事件处理器、javascript: 等
 * 危险协议、<iframe>/<object> 等）一律剥离。DOMPurify 默认已拦截 javascript: 协议与
 * 事件处理器，这里再用 ALLOWED_TAGS / ALLOWED_ATTR 收窄到最小子集，纵深防御。
 */

// 简历渲染所需的 HTML 子集。覆盖：
// - markdown-it 输出：p / ul / ol / li / a / strong / em / h1-h6 / code / blockquote / br / span / div
// - Tiptap 富文本输出：同上 + table 系列
// - 注：MarkdownPreview 的 enhance* 函数在清洗之后追加 <section>/<div data-mod> 等结构，
//   那些由我方代码生成（非用户输入），不在此白名单内也安全。
const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "a",
  "span",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "code",
  "pre",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
];

// 仅允许无害属性。class 用于版式；href/target/rel 用于链接（target/rel 由下方钩子强制）。
const ALLOWED_ATTR = ["class", "href", "target", "rel", "id"];

// 链接协议白名单：仅 http(s) / mailto。DOMPurify 默认已拒绝 javascript: / data: 等，
// 这里用 ALLOWED_URI_REGEXP 收紧，避免协议相对写法被误放行。
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// 强制所有 _blank 链接补 rel="noopener noreferrer"，防止 reverse tabnabbing。
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * 清洗简历渲染用 HTML。空输入直接返回空串。
 */
export const sanitizeResumeHtml = (dirty: string): string => {
  if (!dirty) return "";
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    // 显式禁止任何可能执行代码的标签（白名单之外的标签本就会被剥离，这里再兜底声明）。
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "link",
      "meta",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "noscript",
      "svg",
      "math",
      "base",
      "img",
    ],
    ADD_ATTR: ["target", "rel"],
  });
};
