// 确定性的 Markdown 段落级 diff：把左右两份 markdown 拆成「块」后做 LCS，
// 标记右侧每个块相对左侧是 equal / added / modified。纯函数，零外部依赖。
//
// 设计依据：匹配结果左右对比无需精确到字符级，按「块」粒度已足够让用户扫读
// 出优化点；且块级 LCS 是 O(n*m) 确定性算法，结果可复现，不依赖 LLM。

export type BlockStatus = "equal" | "added" | "modified" | "removed";

export interface DiffBlock {
  /** 原始文本块（右侧视角：equal/added/modified 用 newText；removed 用 oldText） */
  text: string;
  /** 该块在右侧的状态 */
  status: BlockStatus;
  /** 当 status==="modified" 时，左侧对应的原文（用于 hover 展示「改前」） */
  before?: string;
}

/** 按空行切分 markdown 为块，保留每块内部换行 */
function splitBlocks(md: string): string[] {
  // 合并多余空行，按空行分段；标题行单独成块以便定位模块
  const normalized = md.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  const rawChunks = normalized.split(/\n\s*\n/);
  const blocks: string[] = [];
  for (const c of rawChunks) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    blocks.push(trimmed);
  }
  return blocks;
}

/** 块相似度：用字符交集比例判断「修改」还是「新增」 */
function similarity(a: string, b: string): number {
  const sa = new Set(a.replace(/\s+/g, ""));
  const sb = new Set(b.replace(/\s+/g, ""));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const ch of sb) if (sa.has(ch)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

/**
 * 计算右侧 markdown 相对左侧的块级 diff。
 * @returns 右侧视角的有序块列表；左侧被删除的块以 {status:"removed"} 穿插返回，
 *          便于调用方在左侧列单独渲染删除线。
 */
export function diffMarkdown(
  oldMd: string,
  newMd: string
): { left: DiffBlock[]; right: DiffBlock[] } {
  const oldBlocks = splitBlocks(oldMd);
  const newBlocks = splitBlocks(newMd);

  // LCS 动态规划
  const n = oldBlocks.length;
  const m = newBlocks.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldBlocks[i] === newBlocks[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const left: DiffBlock[] = [];
  const right: DiffBlock[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldBlocks[i] === newBlocks[j]) {
      left.push({ text: oldBlocks[i], status: "equal" });
      right.push({ text: newBlocks[j], status: "equal" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.push({ text: oldBlocks[i], status: "removed" });
      i++;
    } else {
      // 右侧新增块：尝试与左侧下一个 equal 之前的块判断是否为「修改」
      const before =
        i < n && similarity(oldBlocks[i], newBlocks[j]) >= 0.35
          ? oldBlocks[i]
          : undefined;
      right.push({
        text: newBlocks[j],
        status: before ? "modified" : "added",
        before,
      });
      j++;
    }
  }
  while (i < n) {
    left.push({ text: oldBlocks[i], status: "removed" });
    i++;
  }
  while (j < m) {
    right.push({ text: newBlocks[j], status: "added" });
    j++;
  }

  return { left, right };
}

/**
 * 提取一段文本命中的关键词（来自匹配结果的关键词列表）。
 * 用于 hover 浮层展示「这段优化命中的关键词」，依据真实、不臆造。
 */
export function hitKeywords(text: string, keywords: string[]): string[] {
  if (!keywords?.length) return [];
  const lower = text.toLowerCase();
  return keywords.filter((k) => k && lower.includes(k.toLowerCase()));
}
