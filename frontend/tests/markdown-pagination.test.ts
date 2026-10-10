import { describe, expect, it } from "vitest";
import {
  MM_TO_PX,
  buildPageWindows,
  paginateBlocks,
  type BlockMetric,
} from "@/components/preview/pagination";

// 一页内容区高度：A4(297mm) - 上下页边距(32px * 2)，与预览/导出同一口径
const CONTENT_AREA = 297 * MM_TO_PX - 64;

it("使用浏览器 CSS 的精确 96dpi 毫米换算，避免多页累计误差", () => {
  expect(MM_TO_PX).toBe(96 / 25.4);
});

/** 由块高度序列生成连续的块度量（块之间无间距） */
const stack = (heights: number[]): BlockMetric[] => {
  let top = 0;
  return heights.map((height) => {
    const block = { top, height };
    top += height;
    return block;
  });
};

describe("paginateBlocks", () => {
  it("内容为空时只渲染一页，不产生空白页", () => {
    expect(paginateBlocks([], CONTENT_AREA)).toEqual([0]);
  });

  it("内容不足一页时不分页", () => {
    expect(paginateBlocks(stack([100, 200]), CONTENT_AREA)).toEqual([0]);
  });

  it("内容恰好填满一页时不分页", () => {
    expect(paginateBlocks(stack([CONTENT_AREA]), CONTENT_AREA)).toEqual([0]);
  });

  it("装不下的块整体推到下一页，切点落在该块的顶边（不从块中间切断）", () => {
    // 前两个块共 1000px，第三个块 200px 放不下（1000 + 200 > 1058）
    const blocks = stack([500, 500, 200]);
    // 第三个块 top = 1000
    expect(paginateBlocks(blocks, CONTENT_AREA)).toEqual([0, 1000]);
  });

  it("标题与下一块之间有样式间距时仍保持同页，与打印 CSS 的 break-after 一致", () => {
    const area = 1000;
    const blocks: BlockMetric[] = [
      { top: 0, height: 900 },
      { top: 940, height: 30, isHeading: true },
      // 20px 的标题下间距：下一块从 990 开始，而不是紧贴标题底边 970。
      { top: 990, height: 100 },
      { top: 1090, height: 890 },
    ];

    // 第一页应在标题前切分；随后 890px 的末块无法和标题内容同页，形成第三页。
    // 旧算法只在 heading.bottom === cut 时回退，会误判成两页。
    expect(paginateBlocks(blocks, area)).toEqual([0, 940, 1090]);
  });

  it("跨页块不会被前一个块的留白推进去：切点始终等于某个块的 top", () => {
    const blocks = stack([300, 300, 300, 300, 300]);
    const cuts = paginateBlocks(blocks, CONTENT_AREA);
    const tops = new Set(blocks.map((b) => b.top));
    for (const cut of cuts) {
      expect(tops.has(cut)).toBe(true);
    }
  });

  it("单块自身超过一页时按内容区高度连续切分（退化为硬切，无法规避）", () => {
    const cuts = paginateBlocks(stack([CONTENT_AREA * 2 + 10]), CONTENT_AREA);
    expect(cuts).toEqual([0, CONTENT_AREA, CONTENT_AREA * 2]);
  });

  it("多个大块连续跨页时，页窗口首尾相接、不漏内容", () => {
    const heights = [CONTENT_AREA * 1.5, CONTENT_AREA * 1.5];
    const total = heights.reduce((a, b) => a + b, 0);
    const cuts = paginateBlocks(stack(heights), CONTENT_AREA);
    expect(cuts).toEqual([0, CONTENT_AREA, CONTENT_AREA * 2]);

    // 每一页窗口都必须与上一页窗口尾部严格相接，否则中间那段内容不会被任何页显示
    const windows = buildPageWindows(cuts, CONTENT_AREA, total);
    let cursor = 0;
    for (const w of windows) {
      expect(w.start).toBeCloseTo(cursor, 6);
      cursor += w.windowHeight;
    }
    expect(cursor).toBeCloseTo(total, 6);
  });

  it("以根节点实测高度决定页数，末尾布局空间不会让预览少算一页", () => {
    const blocks = stack([900, 1000]);

    // 最后一个可分页块止于 1900，但根节点受布局样式影响实际高 2200。
    // 导出浏览器会按 2200 分成三页，预览也必须使用同一实测高度。
    expect(paginateBlocks(blocks, 1000, 2200)).toEqual([
      0,
      900,
      1900,
    ]);
  });

  it("内容区高度非正数时退化为一页，不抛错", () => {
    expect(paginateBlocks(stack([10, 10]), 0)).toEqual([0]);
  });

  it("任意块序列下，页窗口首尾相接且完整覆盖内容（不漏内容、不重叠）", () => {
    const heights = [120, 400, 250, 900, 60, 1500, 300, 800, 40];
    const total = heights.reduce((a, b) => a + b, 0);
    const cuts = paginateBlocks(stack(heights), CONTENT_AREA);
    const windows = buildPageWindows(cuts, CONTENT_AREA, total);

    let cursor = 0;
    for (const w of windows) {
      expect(w.start).toBeCloseTo(cursor, 6);
      expect(w.windowHeight).toBeLessThanOrEqual(CONTENT_AREA + 1e-6);
      cursor += w.windowHeight;
    }
    expect(cursor).toBeCloseTo(total, 6);
  });
});

describe("buildPageWindows", () => {
  it("每页窗口高度不超过内容区高度（内容不会溢出到页边距里）", () => {
    const cuts = [0, 1000, 2000];
    const windows = buildPageWindows(cuts, CONTENT_AREA, 2500);
    for (const w of windows) {
      expect(w.windowHeight).toBeLessThanOrEqual(CONTENT_AREA);
    }
  });

  it("末页窗口到内容总高为止，不凭空留白", () => {
    const windows = buildPageWindows([0, 1000], CONTENT_AREA, 1120);
    expect(windows[0].windowHeight).toBe(1000);
    expect(windows[1].windowHeight).toBe(120);
  });

  it("整块下推产生的留白留在上一页页底，不产生无内容的页", () => {
    const windows = buildPageWindows([0, 1000], CONTENT_AREA, 1300);
    expect(windows.every((w) => w.windowHeight > 0)).toBe(true);
  });

  it("内容为空时窗口高度为 0（渲染为一张空白纸）", () => {
    const windows = buildPageWindows([0], CONTENT_AREA, 0);
    expect(windows).toEqual([{ start: 0, windowHeight: 0 }]);
  });
});
