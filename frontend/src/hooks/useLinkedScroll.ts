import { useEffect, useRef } from "react";

/**
 * 编辑区 ↔ 预览区 滚动联动。
 *
 * 设计取舍：
 * 1. **按比例映射，而非按像素对齐**。两侧内容不可能等长——编辑区是 Markdown
 *    文本流，预览区是分页后缩放的 A4 纸张（含页间间隙、页边距、页码）。按比例
 *    映射保证「滚到底 = 双方都到底」，这是社区通行做法（VS Code Markdown
 *    Preview、Typora、StackEdit 均如此）；按像素对齐在页数 >= 2 时会迅速失配。
 * 2. **用「锁」阻断回环**。A 驱动 B 时，B 会因程序化改 scrollTop 再派发一次
 *    scroll 事件；若不拦，就会形成 A→B→A 的正反馈抖动。这里把「本次滚动由
 *    谁驱动」记在 ref 上，回程事件直接丢弃。
 * 3. **锁用超时释放，而非在事件里立即释放**。scroll 事件的派发时机与
 *    scrollTop 赋值不同帧（浏览器在下一帧合批派发），同帧释放会漏拦。
 *    释放窗口取 140ms：覆盖一次滚动的派发延迟，又短于人手连续滚动的间隔。
 * 4. **不可滚动的一侧直接跳过**。max <= 0（内容比视口短）时比例无意义，
 *    避免除零把对侧强行拉到 0。
 * 5. **一帧一次**。scroll 事件在高刷屏/触控板惯性下每帧可派发多次，每次都读
 *    scrollHeight / clientHeight 会强制同步布局；用 rAF 合并后只取最后位置。
 */

/** 锁释放窗口（ms）：需大于浏览器下一帧派发 scroll 的延迟 */
const LOCK_RELEASE_MS = 140;

/** scrollTop 写入精度容差（px）：小于该值视为「已对齐」，不重复写入 */
const ALIGN_TOLERANCE_PX = 1;

export function useLinkedScroll(
  /** 主动方/被动方之一：编辑器的滚动容器 */
  editorEl: HTMLElement | null,
  /** 另一方：预览的滚动容器 */
  previewEl: HTMLElement | null,
  /** 联动开关：预览面板收起时无意义，应关闭以省掉监听 */
  enabled: boolean
) {
  /** 当前持锁的容器——即「本次滚动被对方驱动」的那一侧 */
  const lockedElRef = useRef<HTMLElement | null>(null);
  const releaseTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !editorEl || !previewEl) return;

    const releaseLock = () => {
      lockedElRef.current = null;
    };

    /** 把 source 的滚动比例同步到 target */
    const syncTo = (source: HTMLElement, target: HTMLElement) => {
      const sourceMax = source.scrollHeight - source.clientHeight;
      const targetMax = target.scrollHeight - target.clientHeight;
      if (sourceMax <= 0 || targetMax <= 0) return;

      const ratio = source.scrollTop / sourceMax;
      const next = Math.round(Math.min(1, Math.max(0, ratio)) * targetMax);
      if (Math.abs(target.scrollTop - next) < ALIGN_TOLERANCE_PX) return;

      // 先持锁再写入：scrollTop 赋值触发的 scroll 事件会异步到达，
      // 届时锁已就位，回程事件被丢弃。
      lockedElRef.current = target;
      target.scrollTop = next;
      window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = window.setTimeout(releaseLock, LOCK_RELEASE_MS);
    };

    // scroll 事件在部分设备（高刷屏、触控板惯性）上每帧可派发多次；
    // 每次都读 scrollHeight/clientHeight 会强制同步布局。用 rAF 合并到一帧一次，
    // 只保留最后一次的 source（滚动是连续动作，中间值无意义）。
    let pending: { source: HTMLElement; target: HTMLElement } | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending) return;
      const { source, target } = pending;
      pending = null;
      syncTo(source, target);
    };

    const makeHandler =
      (source: HTMLElement, target: HTMLElement) => () => {
        // 本次滚动由对方驱动 → 丢弃，避免正反馈
        if (lockedElRef.current === source) return;
        pending = { source, target };
        if (!frame) frame = requestAnimationFrame(flush);
      };

    const onEditorScroll = makeHandler(editorEl, previewEl);
    const onPreviewScroll = makeHandler(previewEl, editorEl);

    // passive: true —— 监听器只读 scrollTop，不阻止默认行为，
    // 让浏览器走合成线程的快速滚动路径。
    editorEl.addEventListener("scroll", onEditorScroll, { passive: true });
    previewEl.addEventListener("scroll", onPreviewScroll, { passive: true });

    return () => {
      editorEl.removeEventListener("scroll", onEditorScroll);
      previewEl.removeEventListener("scroll", onPreviewScroll);
      if (frame) cancelAnimationFrame(frame);
      pending = null;
      window.clearTimeout(releaseTimerRef.current);
      lockedElRef.current = null;
    };
  }, [editorEl, previewEl, enabled]);
}

export default useLinkedScroll;
