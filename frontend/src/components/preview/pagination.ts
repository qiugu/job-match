/**
 * Markdown 简历预览的 A4 分页算法。
 *
 * 设计目标（三条规定了分页的正确性）：
 * 1. 每页可用内容高度 = A4 总高 - 上页边距 - 下页边距，与 PDF 导出口径一致
 *    （打印/服务端导出共用 printHtml.ts 的 buildPrintHtml：@page + #resume-preview padding）。
 *    这样预览里每张纸的上下留白就是真实 PDF 的留白，不会出现「预览贴着纸边、
 *    导出后这段文本被挤到页边距里看不见」的错位。
 * 2. 切点只能落在内容块的边界上：块装不进当前页就整块推到下一页，
 *    绝不从段落/列表项/标题中间切断（切断 = 文本一半在上一页底、一半在下一页顶，
 *    视觉上就是「文字掉进页与页之间的间隙里」）。
 * 3. 不能凭空造出没有任何内容的空白页（历史上按 A4 整高切分时出现过）。
 */
export const MM_TO_PX = 3.78;
export const A4_HEIGHT_PX = 297 * MM_TO_PX;

/** 纸张之间的视觉间隙（px）：只是纸张外边距，不参与内容分页计算 */
export const SHEET_GAP_PX = 16;

/** 一个可独立分页的内容块（相对内容顶部的 top + 自身高度） */
export interface BlockMetric {
  top: number;
  height: number;
  /**
   * 是否为标题块（h1~h6）。
   *
   * 用于 keep-with-next：切点不允许落在标题的底边，否则标题会孤零零留在页尾、
   * 它的内容全在下一页。这与导出/打印的 CSS 规则（break-after: avoid）一致，
   * 保证「预览所见 = 导出所得」。
   *
   * 只按 HTML 语义标签判定，不绑定任何简历版式/模块 class。
   */
  isHeading?: boolean;
}

/**
 * 采集用于分页的块度量：从内容根节点向下收集「叶子块」的 top/height。
 *
 * 关键设计：高度超过一页内容区的块会继续下钻到它的子块（典型是被
 * enhanceBracketSections 包成一整块的 <section>，内部含标题与多个段落/列表），
 * 否则一个超高块只能被页边界硬切，文字照样会被切断。
 * 下钻到「没有子元素」或「高度已能装进一页」为止。
 */
export function collectBlockMetrics(
  root: HTMLElement,
  maxBlockHeight: number
): BlockMetric[] {
  const rootTop = root.getBoundingClientRect().top;
  const out: BlockMetric[] = [];

  const walk = (parent: HTMLElement) => {
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const rect = child.getBoundingClientRect();
      const height = rect.height;
      if (height <= 0) continue;

      if (height > maxBlockHeight && child.children.length > 0) {
        walk(child);
      } else {
        out.push({
          top: rect.top - rootTop,
          height,
          isHeading: /^H[1-6]$/.test(child.tagName),
        });
      }
    }
  };

  walk(root);
  return out;
}

/**
 * 按「固定内容区高度 + 块边界避让」分页，返回每页内容的起始 y（cuts[0] 恒为 0）。
 *
 * 设计目标（保证内容既不漏、也不被页底裁切）：
 * 1. 相邻切点间距恒 ≤ 内容区高度。由此 buildPageWindows 产出的每页窗口
 *    [start, start + windowHeight] 首尾严格相接，完整覆盖 [0, contentHeight]，
 *    不存在任何页「既被本页裁掉、又不在下一页里」而永久丢失的缝隙。
 * 2. 块整体放不进当前页（其顶边落在当前页窗口内、底边的跨到下页）时，
 *    整块推到下一页起点，绝不从段落/列表项/标题中间切断（切断 = 文本一半在
 *    上一页底、一半在下一页顶，视觉上就是「文字掉进页间间隙里被遮挡」）。
 * 3. 单块自身高度就超过一页内容区时（如下钻后仍不可避免的超长表格/代码块），
 *    只能按固定内容区高度从块中间硬切——这是浏览器/HTML 分页的固有行为，
 *    无法规避，但本算法保证切点仍落在内容区边界上、相邻页窗口首尾相接，
 *    因此硬切处的内容在下一页会原样续上，不会丢失。
 *
 * 该算法只依赖块度量（top/height），对内容的具体标签/样式无任何假设，
 * 因此对任意 markdown/HTML 渲染结果都通用，不绑定任何简历版式。
 */
export function paginateBlocks(
  blocks: BlockMetric[],
  contentAreaPx: number
): number[] {
  if (contentAreaPx <= 0) return [0];

  // 内容总高：用于判断何时停止分页（取所有块底边的最大值）
  const contentHeight = blocks.reduce(
    (max, b) => Math.max(max, b.top + b.height),
    0
  );
  if (contentHeight <= 0) return [0];

  // 按 top 排序，便于在「固定切点」处查找被跨断的块
  const sorted = [...blocks].sort((a, b) => a.top - b.top);

  const cuts = [0];
  let pos = 0; // 当前页起点（即上一个切点）

  // 循环推进：只要当前页起点 + 内容区高度还没到达内容末尾，就确定下一页起点
  while (pos + contentAreaPx < contentHeight - 1e-6) {
    const rawCut = pos + contentAreaPx; // 固定内容区边界上的候选切点

    // 找到「底边跨过 rawCut」的块（即若在此切分会被从中间切断的块）
    const containing = sorted.find(
      (b) => b.top < rawCut && b.top + b.height > rawCut
    );

    let cut = rawCut;
    if (containing) {
      const isTall = containing.height > contentAreaPx;
      // 普通块：整块推到下一页，切点落在块的顶边（避免从中间切断）
      // 只有「块顶边 > 当前页起点」时才避让，否则说明该块已在上一页开始，
      // 只能按固定边界硬切（退化为 rawCut）。
      if (!isTall && containing.top > pos) {
        cut = containing.top;
      }
      // 超高块：无法整块容纳，按固定内容区边界硬切（cut 保持 rawCut）
    }

    // keep-with-next：切点不允许落在标题的底边，否则标题会孤零零留在页尾。
    // 此时把切点回退到标题顶边，让标题与后续内容同页（前提是该标题不是本页首块，
    // 否则回退后本页零推进，只能接受标题留在页尾）。
    const trailingHeading = sorted.find(
      (b) =>
        b.isHeading &&
        b.top > pos &&
        Math.abs(b.top + b.height - cut) < 0.5
    );
    if (trailingHeading) {
      cut = trailingHeading.top;
    }

    // 安全约束：切点必须严格前进、且不超过固定内容区边界
    // （避免出现 0 推进导致死循环，或切点越过内容区而制造漏内容的缝隙）
    cut = Math.max(pos + 1e-6, Math.min(rawCut, cut));

    cuts.push(cut);
    pos = cut;
  }

  return cuts;
}

/**
 * 由切点推导每页的窗口高度：
 * - 有下一页时，窗口到下一页起点为止（整块下推产生的留白留在页底）；
 * - 末页窗口到内容总高为止；
 * - 两种情况都不超过内容区高度，保证内容不会溢出到页边距里。
 */
export function buildPageWindows(
  cuts: number[],
  contentAreaPx: number,
  contentHeightPx: number
): Array<{ start: number; windowHeight: number }> {
  return cuts.map((start, i) => {
    const nextStart = cuts[i + 1];
    const end =
      nextStart !== undefined ? nextStart : Math.max(contentHeightPx, start);
    return {
      start,
      windowHeight: Math.max(0, Math.min(contentAreaPx, end - start)),
    };
  });
}
