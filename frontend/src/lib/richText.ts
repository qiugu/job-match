import { sanitizeResumeHtml } from "@/lib/sanitize";

const HTML_TAG_REGEX = /<\/?[a-z][\s\S]*>/i;
const EMPTY_PARAGRAPH_REGEX = /<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi;
const HTML_BREAK_REGEX = /<br\s*\/?>/gi;
const HTML_ANY_TAG_REGEX = /<\/?[^>]+>/g;
const INVISIBLE_WHITESPACE_REGEX = /[\s\u200B-\u200D\uFEFF]/g;
const TRAILING_LIST_PARAGRAPH_REGEX =
  /(<\/(?:ul|ol)>)\s*<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*$/i;
const RICH_TEXT_ANCHOR_REGEX = /<a\b([^>]*)>/gi;
const CLASS_ATTRIBUTE_REGEX = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i;
const CLASS_ATTRIBUTE_GLOBAL_REGEX = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_REGEX =
  /^(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:[/?#][^\s]*)?$/i;
const SAFE_LINK_PROTOCOL_REGEX = /^(https?:|mailto:|tel:)/i;
const ANY_PROTOCOL_REGEX = /^[a-z][a-z\d+\-.]*:/i;
const LEGACY_RICH_TEXT_CLASSES = new Set(["custom-list", "custom-list-ordered"]);

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const decorateRichTextAnchors = (content: string) =>
  content.replace(RICH_TEXT_ANCHOR_REGEX, (match, attrs: string) => {
    // S2 修复：原实现只补 class，从不校验 href。这里用 normalizeLinkHref 规范化协议
    // （// → https:、裸域名 → https://、javascript:/data: 等危险协议返回 null），
    // 危险链接直接剥离 <a> 仅保留文本。
    const hrefMatch = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs);
    const safeHref = hrefMatch ? normalizeLinkHref(hrefMatch[1] ?? hrefMatch[2]) : null;

    if (hrefMatch && !safeHref) {
      return match.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>/i, "");
    }

    let result = match;
    if (safeHref) {
      result = result.replace(/href\s*=\s*("([^"]*)"|'([^']*)')/i, `href="${safeHref}"`);
    }

    if (CLASS_ATTRIBUTE_REGEX.test(attrs)) {
      result = result.replace(CLASS_ATTRIBUTE_REGEX, (_classMatch, quotedValue, doubleQuoted, singleQuoted) => {
        const currentValue = doubleQuoted ?? singleQuoted ?? quotedValue ?? "";
        const classes = currentValue.split(/\s+/).filter(Boolean);

        if (!classes.includes("rich-text-link")) {
          classes.push("rich-text-link");
        }

        return `class="${classes.join(" ")}"`;
      });
    } else {
      result = result.replace(/^<a\b/i, '<a class="rich-text-link"');
    }

    return result;
  });

export const stripLegacyRichTextClasses = (content?: string) => {
  if (!content) return "";

  return content.replace(
    CLASS_ATTRIBUTE_GLOBAL_REGEX,
    (_match, quotedValue, doubleQuoted, singleQuoted) => {
      const currentValue = doubleQuoted ?? singleQuoted ?? quotedValue ?? "";
      const classes = currentValue
        .split(/\s+/)
        .filter(Boolean)
        .filter((className: string) => !LEGACY_RICH_TEXT_CLASSES.has(className));

      return classes.length ? `class="${classes.join(" ")}"` : "";
    }
  );
};

export const stripTrailingListParagraph = (content?: string) => {
  if (!content) return "";

  let normalized = content;

  while (TRAILING_LIST_PARAGRAPH_REGEX.test(normalized)) {
    normalized = normalized.replace(TRAILING_LIST_PARAGRAPH_REGEX, "$1");
  }

  return normalized;
};

export const normalizeLinkHref = (href?: string) => {
  if (!href) return null;

  const value = href.trim();
  if (!value) return null;

  if (SAFE_LINK_PROTOCOL_REGEX.test(value)) {
    return value;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (EMAIL_REGEX.test(value)) {
    return `mailto:${value}`;
  }

  if (DOMAIN_REGEX.test(value)) {
    return `https://${value}`;
  }

  if (ANY_PROTOCOL_REGEX.test(value)) {
    return null;
  }

  return null;
};

/**
 * 规范化富文本内容，解决以下问题：
 * 1. 纯文本中的换行无法在 HTML 中展示；
 * 2. TipTap 产生的空 <p> 标签没有高度。
 */
export const normalizeRichTextContent = (content?: string) => {
  if (!content) return "";

  let normalized = content;

  if (!HTML_TAG_REGEX.test(content)) {
    normalized = escapeHtml(content).replace(/\r\n|\r|\n/g, "<br />");
  }

  // S2 修复：Tiptap 富文本可能携带原始 HTML（用户粘贴 / 含标签内容）。原实现在「含 HTML
  // 标签即完全信任」分支下不做任何清洗，直接 dangerouslySetInnerHTML。这里在返回前做白名单
  // 清洗，剥离 <script> / 事件处理器 / 危险协议（normalizeLinkHref 已在上方拦截危险链接）。
  return sanitizeResumeHtml(
    decorateRichTextAnchors(
      stripTrailingListParagraph(stripLegacyRichTextClasses(normalized))
    ).replace(EMPTY_PARAGRAPH_REGEX, "<p><br /></p>")
  );
};

export const hasMeaningfulRichTextContent = (content?: string) => {
  if (!content) return false;

  if (!HTML_TAG_REGEX.test(content)) {
    return content.replace(INVISIBLE_WHITESPACE_REGEX, "").length > 0;
  }

  const plainText = content
    .replace(EMPTY_PARAGRAPH_REGEX, "")
    .replace(HTML_BREAK_REGEX, "")
    .replace(/&nbsp;/gi, " ")
    .replace(HTML_ANY_TAG_REGEX, "")
    .replace(INVISIBLE_WHITESPACE_REGEX, "");

  return plainText.length > 0;
};
