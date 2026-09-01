import MarkdownIt from "markdown-it";

// 单例 MarkdownIt 实例：负责将 Markdown 源文本解析为 HTML。
// 这是架构中的 "Markdown Parser" 环节。
const md = new MarkdownIt({
  // 允许原始 HTML 透传：原简历来自 PDF 提取，会带 <ul><li> 等残存标签，
  // html:false 会把它们转义成 &lt;ul&gt;，导致列表丢失、字面渲染 "<ul>" 文本。
  // 简历 markdown 不接受用户上传内容（仅服务端 LLM 与 PDF 提取），XSS 面极小。
  html: true,
  // 不自动识别裸 URL 为链接：简历正文里的网址应作为纯文本渲染，
  // 除非用户显式用 [文字](url) 语法写链接（markdown-it 的 link 规则仍会渲染）。
  // 与 AIPolishDialog 的 linkify:false 保持一致，避免渲染层主动套 <a> 标签。
  linkify: false,
  typographer: true,
  // 渲染语义：单 \n = 软换行（空格连接），\n\n = 硬换行/段落分隔（CommonMark 标准）。
  // 早期曾开启 breaks:true（单 \n 即渲染为 <br> 硬换行），但 PDF 提取会把超长句子按
  // 页面宽度切分为多个视觉行并以单 \n 输出，breaks:true 会把这些「句子续行」渲染成
  // <br>，产生「前端↵工程体系搭建」这类破坏词义的词中断行。改为 breaks:false 后，
  // 单 \n 统一空格连接（符合语义且不破坏词义），真正的段落仍由 \n\n 分隔，不受影响。
  breaks: false,
});

// 自定义链接渲染：新窗口打开 + 安全 rel，符合简历 PDF 导出的既有约定
const defaultRender =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultRender(tokens, idx, options, env, self);
};

// :::position 容器标签（受 markdown-it-container 语法启发）
// 支持两种用法：
// 1. 多行块容器（段落/列表整体对齐）：
//    :::left
//    内容
//    :::
// 2. 单行内联容器（用于“左侧学校 | 右侧日期”这种同一行左右分布）：
//    :::left 内容 ::: :::right 内容 :::
// 手写 block rule，零额外依赖，与既有 markdown-it 单例保持一致。
const ALIGN_CONTAINER_NAMES = ["left", "center", "right"] as const;
type AlignContainerName = (typeof ALIGN_CONTAINER_NAMES)[number];
const ALIGN_CLASS_MAP: Record<AlignContainerName, string> = {
  left: "md-align-left",
  center: "md-align-center",
  right: "md-align-right",
};

// 兼容大小写：LLM 可能输出 :::Center / :::CENTER 等写法
const isAlignContainerName = (name: string): name is AlignContainerName =>
  (ALIGN_CONTAINER_NAMES as readonly string[]).includes(name.toLowerCase());

interface InlineAlignSegment {
  name: AlignContainerName;
  content: string;
  endPos: number;
}

const parseInlineAlignSegment = (
  src: string,
  startPos: number,
  max: number
): InlineAlignSegment | null => {
  if (src.slice(startPos, startPos + 3) !== ":::") return null;

  let pos = startPos + 3;
  // `:::` 后允许空白再读标签名（兼容 `::: left` 写法）
  while (pos < max && /\s/.test(src[pos])) pos++;
  let name = "";
  while (pos < max && src[pos] !== "\n" && !/\s/.test(src[pos])) {
    name += src[pos];
    pos++;
  }
  if (!isAlignContainerName(name)) return null;

  // 找同一行内的结束标记 " :::"
  let closePos = -1;
  for (let scan = pos; scan <= max - 4; scan++) {
    if (src.slice(scan, scan + 4) === " :::") {
      closePos = scan;
      break;
    }
  }
  if (closePos === -1) return null;

  let contentStart = pos;
  while (contentStart < closePos && /\s/.test(src[contentStart])) contentStart++;
  let contentEnd = closePos;
  while (contentEnd > contentStart && /\s/.test(src[contentEnd - 1])) contentEnd--;

  return {
    name,
    content: src.slice(contentStart, contentEnd),
    endPos: closePos + 4,
  };
};

// 导出以便编辑器（Tiptap）复用同一套 :::left/center/right 解析规则，
// 保证预览与编辑器对容器语法的理解完全一致。
export const alignContainerPlugin = (mdInstance: typeof MarkdownIt.prototype) => {
  // 注册自定义 token 渲染器
  mdInstance.renderer.rules.align_container_open = (tokens: any, idx: number, options: any, env: any, self: any) =>
    self.renderToken(tokens, idx, options);
  mdInstance.renderer.rules.align_container_close = (tokens: any, idx: number, options: any, env: any, self: any) =>
    self.renderToken(tokens, idx, options);
  mdInstance.renderer.rules.align_inline_open = (tokens: any, idx: number, options: any, env: any, self: any) =>
    self.renderToken(tokens, idx, options);
  mdInstance.renderer.rules.align_inline_close = (tokens: any, idx: number, options: any, env: any, self: any) =>
    self.renderToken(tokens, idx, options);
  // 配对行（left/center + right 合并为同一行）直接输出预渲染 HTML
  mdInstance.renderer.rules.align_pair_row = (tokens: any, idx: number) => tokens[idx].content;

  // 在 block 解析阶段识别 `:::name ... :::` 结构
  mdInstance.block.ruler.before("fence", "align_container", (state, startLine, endLine, silent) => {
    // 行首必须是 `:::`
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    const lineStart = pos;
    const max = state.eMarks[startLine];

    if (pos + 3 > max) return false;
    if (state.src.slice(pos, pos + 3) !== ":::") return false;

    pos += 3;

    // `:::` 后允许空白再读标签名（兼容 `::: left` 写法）
    while (pos < max && /\s/.test(state.src[pos])) pos++;
    if (pos >= max || state.src[pos] === "\n") return false;

    // 读取标签名（left/center/right），允许后接空白
    let name = "";
    while (pos < max && state.src[pos] !== "\n" && !/\s/.test(state.src[pos])) {
      name += state.src[pos];
      pos++;
    }

    if (!isAlignContainerName(name)) return false;

    if (silent) return true;

    // ============= 单行内联模式 =============
    // 尝试从行首开始解析连续的单行 align 容器
    const segments: InlineAlignSegment[] = [];
    let segPos = lineStart;

    while (segPos < max) {
      const segment = parseInlineAlignSegment(state.src, segPos, max);
      if (!segment) break;
      segments.push(segment);
      segPos = segment.endPos;
      // 跳过容器之间的空白
      while (segPos < max && /\s/.test(state.src[segPos])) segPos++;
    }

    if (segments.length > 0) {
      const tokenOpen = state.push("paragraph_open", "p", 1);
      tokenOpen.map = [startLine, startLine + 1];

      const inlineToken = state.push("inline", "", 0);
      // 已手动填充 inline children；将 content 置空可避免 markdown-it 的 core inline ruler
      // 在 block parse 后再次解析并追加重复内容。
      inlineToken.content = "";
      inlineToken.map = [startLine, startLine + 1];
      inlineToken.children = [];

      for (const segment of segments) {
        const spanOpen = new state.Token("align_inline_open", "span", 1);
        spanOpen.attrSet("class", ALIGN_CLASS_MAP[segment.name]);
        const spanClose = new state.Token("align_inline_close", "span", -1);

        inlineToken.children.push(spanOpen);
        state.md.inline.parse(segment.content, state.md, state.env, inlineToken.children);
        inlineToken.children.push(spanClose);
      }

      state.push("paragraph_close", "p", -1);

      state.line = startLine + 1;
      return true;
    }

    // ============= 多行块容器模式 =============
    // 仅消费标签行剩余空白
    while (pos < max && /\s/.test(state.src[pos])) pos++;
    if (pos < max && state.src[pos] !== "\n") return false; // 标签行出现非法尾随内容

    // 解析一个多行块：从 open 行（已确认）找到对应的 `:::` 结束行，
    // 返回内容行范围 [contentStart, closeLine)
    const parseBlockRange = (
      openLine: number
    ): { contentStart: number; closeLine: number } | null => {
      let nl = openLine + 1;
      let foundClose = false;
      while (nl < endLine) {
        const bS = state.bMarks[nl] + state.tShift[nl];
        const bM = state.eMarks[nl];
        if (bS + 3 <= bM && state.src.slice(bS, bS + 3) === ":::") {
          let tail = bS + 3;
          let validClose = true;
          while (tail < bM) {
            if (!/\s/.test(state.src[tail])) {
              validClose = false;
              break;
            }
            tail++;
          }
          if (validClose) {
            foundClose = true;
            break;
          }
        }
        nl++;
      }
      if (!foundClose) return null;
      return { contentStart: openLine + 1, closeLine: nl };
    };

    const first = parseBlockRange(startLine);
    if (!first) return false;

    // 渲染某个块的纯内容（多行文本）为 HTML（由 markdown-it 自身 sanitize）
    const renderBlockContent = (block: { contentStart: number; closeLine: number }): string => {
      const lines: string[] = [];
      for (let l = block.contentStart; l < block.closeLine; l++) {
        lines.push(state.src.slice(state.bMarks[l], state.eMarks[l]));
      }
      return md.render(lines.join("\n"));
    };

    // 尝试配对：主块（非 right）后紧接 `:::right` 块时，合并为同一行
    const isMain = name !== "right";
    let second: { contentStart: number; closeLine: number } | null = null;

    if (isMain) {
      // 跳过块之间的空行，找到下一个非空块起始行
      let rightLine = first.closeLine + 1;
      while (
        rightLine < endLine &&
        state.bMarks[rightLine] + state.tShift[rightLine] >= state.eMarks[rightLine]
      ) {
        rightLine++;
      }
      const rStart = state.bMarks[rightLine] + state.tShift[rightLine];
      const rMax = state.eMarks[rightLine];
      let rPos = rStart;
      if (rPos + 3 <= rMax && state.src.slice(rPos, rPos + 3) === ":::") {
        rPos += 3;
        // `:::` 后允许空白再读标签名
        while (rPos < rMax && /\s/.test(state.src[rPos])) rPos++;
        let rName = "";
        while (rPos < rMax && state.src[rPos] !== "\n" && !/\s/.test(state.src[rPos])) {
          rName += state.src[rPos];
          rPos++;
        }
        // 标签行其余部分必须为空或仅空白
        while (rPos < rMax && /\s/.test(state.src[rPos])) rPos++;
        if (rName === "right" && rPos >= rMax) {
          second = parseBlockRange(rightLine);
        }
      }
    }

    if (second) {
      // 合并为一行：外层 flex 容器，内部左右两个块各自渲染内容
      const mainHtml = renderBlockContent(first);
      const rightHtml = renderBlockContent(second);
      const rowToken = state.push("align_pair_row", "", 0);
      rowToken.block = true;
      rowToken.content =
        `<div class="md-pair-row">` +
        `<div class="md-align-${name}">${mainHtml}</div>` +
        `<div class="md-align-right">${rightHtml}</div>` +
        `</div>`;
      state.line = second.closeLine + 1;
      return true;
    }

    // 无配对：单块 div（整体对齐）
    const openToken = state.push("align_container_open", "div", 1);
    openToken.markup = ":::";
    openToken.block = true;
    openToken.map = [startLine, first.closeLine];
    openToken.attrSet("class", ALIGN_CLASS_MAP[name]);

    // 标签行与结束行本身不进入内容渲染：推进 state.line 后交给子解析器
    state.line = startLine + 1;
    state.md.block.tokenize(state, startLine + 1, first.closeLine);

    const closeToken = state.push("align_container_close", "div", -1);
    closeToken.markup = ":::";
    closeToken.block = true;

    state.line = first.closeLine + 1;
    return true;
  });
};

md.use(alignContainerPlugin);

export const renderMarkdownToHtml = (markdown: string): string => {
  if (!markdown || !markdown.trim()) return "";
  const raw = md.render(markdown);
  // 兜底：alignContainerPlugin 仅消费 :::left/center/right 且严格配对的块。
  // LLM 自由生成的 ::: （如孤立 ::: 分隔符、:::info、闭合缺失、缩进偏差）
  // 会原样透传为裸露 ":::" 文本。这里在 HTML 层面把残留的 ::: 段落清除，
  // 避免页面上出现无意义的 ":::" 符号。已正常消费的 ::: 会渲染成
  // <div class="md-align-*"> 而非 <p>:::</p>，不受影响。
  return raw
    .replace(/<p>\s*:::\s*<\/p>/g, "")
    .replace(/<p>\s*:::\s*[a-zA-Z]+\s*<\/p>/g, "");
};

export default md;
