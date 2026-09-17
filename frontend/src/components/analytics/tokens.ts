/**
 * 图表配色桥接：把 `.theme-xai` 作用域的具名令牌解析为 ECharts 可用的真实色值。
 *
 * 为什么必须这样做：
 * - ECharts 在 **Canvas** 上渲染，无法解析 CSS 变量（`var(--xai-text)` 会画成黑色）；
 * - 本项目的主题是 `html.light` / `html.dark` 上的 class（next-themes 驱动），
 *   色值定义在 `.theme-xai` 作用域内 ⇒ 只能用 `getComputedStyle` 在**运行时**读出；
 * - 因此图表容器必须位于 `.theme-xai` 子树内，否则取到的是 `:root` 的深色兜底值。
 *
 * 纪律：**禁止在图表代码里硬编码色值**（品牌强调色 `BRAND_ACCENT` 是唯一例外），
 * 否则浅色/深色主题切换时会出现不可读的图表。
 */
import type { JobStatus } from "@/lib/jobmatch";

/**
 * 品牌唯一强调色（靛蓝）。占比应 ≤10%，用于「投递」这一最重要的语义，
 * 其余阶段用同色不同明度构成**单色阶**——阶段是有序量，单色阶比多色分类更准确。
 * 定义见 docs/BRAND.md。
 */
export const BRAND_ACCENT = "#5E6AD2";

export interface ChartTokens {
  /** 面板底色（用于把强调色朝底色混合出同色阶） */
  surface: string;
  surface2: string;
  hairline: string;
  hairlineSoft: string;
  text: string;
  textMid: string;
  mute: string;
  eyebrow: string;
  fontSans: string;
  fontMono: string;
}

/** 无 DOM（SSR / 单测）时的兜底：取深色主题的值，保证函数在任何环境都可用。 */
export const FALLBACK_TOKENS: ChartTokens = {
  surface: "#131418",
  surface2: "#1a1c21",
  hairline: "#292b33",
  hairlineSoft: "#1f2126",
  text: "#ffffff",
  textMid: "#e7e9ec",
  mute: "#8a8f98",
  eyebrow: "#6b727b",
  fontSans: 'Inter, "Noto Sans SC", system-ui, sans-serif',
  fontMono: '"Geist Mono", ui-monospace, SFMono-Regular, monospace',
};

function toRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * 线性混合两个十六进制色：`t=0` 返回 a，`t=1` 返回 b。
 *
 * 用「混合」而非「降低透明度」来派生同色阶：Canvas 上叠加半透明色会露出底层网格线，
 * 在深色主题下显得浑浊。混合得到的是实色，任何背景上都稳定。
 * 若传入了无法解析的值（例如令牌缺失），按原样回退为 a，绝不抛错。
 */
export function mixHex(a: string, b: string, t: number): string {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) return a;
  const clamp = Math.min(1, Math.max(0, t));
  const ch = (i: number) =>
    Math.round(ra[i] + (rb[i] - ra[i]) * clamp)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/** 读取 `.theme-xai` 作用域下的具名令牌；元素缺失或令牌为空时回退到兜底值。 */
export function readChartTokens(el: HTMLElement | null | undefined): ChartTokens {
  if (!el || typeof window === "undefined" || !window.getComputedStyle) {
    return FALLBACK_TOKENS;
  }
  const cs = window.getComputedStyle(el);
  const get = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;

  return {
    surface: get("--xai-surface", FALLBACK_TOKENS.surface),
    surface2: get("--xai-surface-2", FALLBACK_TOKENS.surface2),
    hairline: get("--xai-hairline", FALLBACK_TOKENS.hairline),
    hairlineSoft: get("--xai-hairline-soft", FALLBACK_TOKENS.hairlineSoft),
    text: get("--xai-text", FALLBACK_TOKENS.text),
    textMid: get("--xai-text-mid", FALLBACK_TOKENS.textMid),
    mute: get("--xai-mute", FALLBACK_TOKENS.mute),
    eyebrow: get("--xai-eyebrow", FALLBACK_TOKENS.eyebrow),
    fontSans: get("--xai-font-sans", FALLBACK_TOKENS.fontSans),
    fontMono: get("--xai-font-mono", FALLBACK_TOKENS.fontMono),
  };
}

/**
 * 阶段 → 颜色。
 *
 * 阶段是有序量（待回复 → 待投递 → 已投递），故用**靛蓝单色阶**表达深浅，
 * 而不是四个分类色：单色阶能同时传达「顺序」与「占比」，且符合品牌「唯一强调色」约束。
 * `closed`（已结束）是终态**分支**而非阶段，用中性灰，不参与色阶。
 */
export function stageColor(stage: JobStatus, tokens: ChartTokens): string {
  switch (stage) {
    case "applied":
      return BRAND_ACCENT; // 最高阶：满色
    case "resume_ready":
      return mixHex(BRAND_ACCENT, tokens.surface, 0.38);
    case "greeting_sent":
      return mixHex(BRAND_ACCENT, tokens.surface, 0.68);
    case "closed":
      return mixHex(tokens.mute, tokens.surface, 0.25);
  }
}

/** 图表通用的坐标轴/网格描边色（hairline 体系，无阴影）。 */
export function axisColors(tokens: ChartTokens) {
  return {
    line: tokens.hairlineSoft,
    split: tokens.hairlineSoft,
    label: tokens.mute,
  };
}
