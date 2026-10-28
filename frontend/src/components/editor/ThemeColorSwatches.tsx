import { cn } from "@/lib/utils";

interface ThemeColorSwatchesProps {
  /** 可选色值（十六进制），顺序即展示顺序 */
  colors: readonly string[];
  /** 当前选中的色值 */
  value: string;
  onChange: (color: string) => void;
  /** 色值 → 可读名称（用于 aria-label 与 title，避免把 #2B3AFF 当可访问名） */
  labelFor?: (color: string) => string;
  className?: string;
}

/**
 * 强调色色板（设计稿 03 `.swatches-row` / `.swatch`）。
 *
 * 与旧实现的差别：
 * - 色块是 **20px 圆形 + 墨色 1.5px 描边**，选中态用「双环」（card 底色内环 +
 *   墨色外环），而不是加阴影或放大——纸墨体系禁柔光阴影，且放大位移会让整排
 *   色块跳动。
 * - 语义为 `radiogroup`：色块是单选，读屏器需要读出当前选中项，
 *   而不能只靠视觉描边。
 */
export function ThemeColorSwatches({
  colors,
  value,
  onChange,
  labelFor,
  className,
}: ThemeColorSwatchesProps) {
  const nameOf = (color: string) => labelFor?.(color) || color;
  const normalized = value?.toLowerCase();

  return (
    <div
      role="radiogroup"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {colors.map((color) => {
        const active = normalized === color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={nameOf(color)}
            title={nameOf(color)}
            onClick={() => onChange(color)}
            className={cn(
              "h-5 w-5 shrink-0 rounded-full border-[1.5px] border-ink transition-shadow",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cobalt/40",
              active && "shadow-[0_0_0_2px_var(--card),0_0_0_3.5px_var(--ink)]"
            )}
            style={{ backgroundColor: color }}
          />
        );
      })}
    </div>
  );
}

export default ThemeColorSwatches;
