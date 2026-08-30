import { useMemo, useRef, useState } from "react";
import { diffMarkdown, hitKeywords, type DiffBlock } from "../../utils/diffMarkdown";
import type { MatchAnalysis, MatchRequirement } from "../../lib/jobmatch";

interface ResumeDiffViewProps {
  /** 原简历（markdown 或纯文本） */
  original: string;
  /** 优化后简历（markdown） */
  optimized: string;
  /** 匹配结果关键词，用于 hover 浮层命中标示 */
  keywords: string[];
  /** 匹配分析，用于 hover 浮层关联建议 */
  analysis?: MatchAnalysis | null;
}

/** 把某块文本关联到匹配分析里相关的 requirement（按关键词/文本相交判断） */
function relatedRequirements(
  block: DiffBlock,
  analysis?: MatchAnalysis | null
): MatchRequirement[] {
  if (!analysis?.requirements?.length || block.status === "equal") return [];
  const text = (block.text + " " + (block.before ?? "")).toLowerCase();
  return analysis.requirements.filter((r) => {
    const kw = (r.requirement || "").toLowerCase().split(/[，。；;、]/).some(
      (s) => s.length > 1 && text.includes(s.trim().toLowerCase())
    );
    const ev = (r.evidence || "").toLowerCase().split(/[，。；;]/).some((s) =>
      s.length > 2 && text.includes(s.trim().toLowerCase())
    );
    return kw || ev;
  });
}

export default function ResumeDiffView({
  original,
  optimized,
  keywords,
  analysis,
}: ResumeDiffViewProps) {
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [synced, setSynced] = useState(true);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  // 同步滚动时防止事件回环：标记当前由程序触发的同步
  const isSyncing = useRef(false);

  const { left, right } = useMemo(
    () => diffMarkdown(original || "", optimized || ""),
    [original, optimized]
  );

  const changedCount = useMemo(
    () => right.filter((b) => b.status !== "equal").length,
    [right]
  );

  const leftBlocks = onlyChanged
    ? left.filter((b) => b.status !== "equal")
    : left;
  const rightBlocks = onlyChanged
    ? right.filter((b) => b.status !== "equal")
    : right;

  // 按比例同步两栏滚动位置
  const handleScroll = (source: "left" | "right") => () => {
    if (!synced || isSyncing.current) return;
    const from = source === "left" ? leftRef.current : rightRef.current;
    const to = source === "left" ? rightRef.current : leftRef.current;
    if (!from || !to) return;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    if (fromMax <= 0 || toMax <= 0) return;
    isSyncing.current = true;
    to.scrollTop = (from.scrollTop / fromMax) * toMax;
    // 下一帧解除标记，避免目标栏 scroll 事件触发回环
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  };

  return (
    <div className="flex h-auto min-h-0 flex-col">
      {/* 顶部控制条 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3 text-sm text-default-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-success/70" />
            新增内容
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-warning/70" />
            修改内容
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-danger/40" />
            删除内容
          </span>
          <span className="ml-1 text-default-400">共 {changedCount} 处改动</span>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-default-600">
            <input
              type="checkbox"
              checked={onlyChanged}
              onChange={(e) => setOnlyChanged(e.target.checked)}
              className="accent-primary"
            />
            只看改动
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-default-600">
            <input
              type="checkbox"
              checked={synced}
              onChange={(e) => setSynced(e.target.checked)}
              className="accent-primary"
            />
            同步滚动
          </label>
        </div>
      </div>

      {/* 左右对比 */}
      <div className="grid flex-1 grid-cols-2 gap-px overflow-hidden bg-border">
        {/* 左：原简历 */}
        <div
          ref={leftRef}
          onScroll={handleScroll("left")}
          className="min-h-0 overflow-y-auto bg-background p-5"
        >
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-default-400">
            原简历
          </div>
          <div className="space-y-3">
            {leftBlocks.map((b, idx) => (
              <DiffBlockView key={`l-${idx}`} block={b} side="left" />
            ))}
          </div>
        </div>

        {/* 右：优化后 */}
        <div
          ref={rightRef}
          onScroll={handleScroll("right")}
          className="min-h-0 overflow-y-auto bg-background p-5"
        >
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-default-400">
            优化后简历
          </div>
          <div className="space-y-3">
            {rightBlocks.map((b, idx) => (
              <DiffBlockView
                key={`r-${idx}`}
                block={b}
                side="right"
                keywords={keywords}
                requirements={relatedRequirements(b, analysis)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffBlockView({
  block,
  side,
  keywords = [],
  requirements = [],
}: {
  block: DiffBlock;
  side: "left" | "right";
  keywords?: string[];
  requirements?: MatchRequirement[];
}) {
  const [open, setOpen] = useState(false);
  const isChanged = block.status !== "equal";

  const base =
    "group relative whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed shadow-sm transition-colors";
  let tone = "border-border bg-content1 text-default-700";
  if (side === "left") {
    if (block.status === "removed")
      tone = "border-danger/30 bg-danger/5 text-default-400 line-through decoration-danger/40";
  } else {
    if (block.status === "added")
      tone = "border-success/40 bg-success/10 text-default-800";
    else if (block.status === "modified")
      tone = "border-warning/50 bg-warning/10 text-default-800";
  }

  const hits = side === "right" ? hitKeywords(block.text, keywords) : [];
  const showPopover = side === "right" && isChanged && (hits.length > 0 || requirements.length > 0);

  return (
    <div
      className={`${base} ${tone}`}
      onMouseEnter={() => showPopover && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {side === "right" && isChanged && (
        <span
          className={`absolute -left-1.5 top-3 h-[calc(100%-1.5rem)] w-1 rounded-full ${
            block.status === "added" ? "bg-success" : "bg-warning"
          }`}
        />
      )}

      {block.status === "modified" && block.before && (
        <div className="mb-1.5 border-b border-warning/30 pb-1.5 text-xs text-default-400 line-through decoration-warning/50">
          {block.before}
        </div>
      )}

      <div>{block.text}</div>

      {showPopover && (
        <div
          className={`absolute left-0 top-full z-20 mt-1.5 w-[min(360px,90%)] rounded-xl border border-border bg-content1 p-3 text-xs shadow-lg transition-opacity ${
            open ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="mb-1.5 font-semibold text-default-500">
            修改依据
          </div>
          {hits.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {hits.map((k) => (
                <span
                  key={k}
                  className="rounded-full bg-primary/15 px-2 py-0.5 text-primary"
                >
                  {k}
                </span>
              ))}
            </div>
          )}
          {requirements.length > 0 ? (
            <ul className="space-y-2.5">
              {requirements.map((r, i) => (
                <li key={i} className="text-default-600">
                  <span className="font-medium text-default-700">
                    {r.requirement}
                  </span>
                  {r.evidence && (
                    <p className="mt-0.5 text-default-400">{r.evidence}</p>
                  )}
                  {r.suggestion && (
                    <p className="mt-1.5 rounded-md bg-default-100 px-2 py-1.5 text-default-600">
                      <span className="font-medium text-default-500">建议：</span>
                      {r.suggestion}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            hits.length > 0 && (
              <p className="text-default-400">
                该段命中上方关键词，已按岗位描述强化表述。
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}
