import React from "react";

/**
 * JDMatch 主标识（正方形，100×100 构造网格）。
 *
 * 造型：J 与 D 共用同一条垂直主脊 —— 主脊既是 J 的笔画，也是 D 的竖杆；
 * D 的碗形向右展开，J 的钩形自主脊末端向左回卷，两字咬合成一个不可分割的整体，
 * 对应「匹配」的本质：不是拼接，而是恰好合上。
 *
 * 着色：主脊使用 currentColor，因此自动跟随外层文字颜色，浅色 / 深色主题下都能正确
 * 显示。旧的 `<img src="/logo.svg">` 实现依赖 `prefers-color-scheme` 媒体查询，与本项目
 * 基于 class 的主题机制（next-themes）不一致；同时它以正方形尺寸渲染 3:2 的源图，
 * 造成标识变形 —— 两处问题在本次替换中一并修掉。
 *
 * 完整规范（尺寸、留白、禁忌、色值）见 docs/BRAND.md。
 */

/** 品牌强调色：仅用于标识中的钩形、主行动按钮与关键数值。 */
export const BRAND_ACCENT = "#5E6AD2";

/** 主脊宽度（构造网格单位），同时作为最小留白基准 x = 标识高度的 14%。 */
export const MARK_STEM_WIDTH = 14;

/** 主标识的构造网格尺寸。 */
export const MARK_VIEW_BOX = 100;

interface LogoProps {
  /** 标识边长（px）。标识为正方形，等比缩放，不会变形。 */
  size?: number;
  className?: string;
  onClick?: () => void;
  /** 单色模式：钩形与主脊同色（继承 currentColor），用于单色印刷等受限场景。 */
  mono?: boolean;
}

const Logo: React.FC<LogoProps> = ({
  size = 100,
  className = "",
  onClick,
  mono = false,
}) => (
  <svg
    viewBox={`0 0 ${MARK_VIEW_BOX} ${MARK_VIEW_BOX}`}
    width={size}
    height={size}
    fill="none"
    role="img"
    aria-label="JDMatch"
    className={className}
    onClick={onClick}
    // 标识是品牌资产，任何 flex 容器里都不应被压缩变形
    style={{ flexShrink: 0 }}
  >
    {/* 主脊：J 的笔画与 D 的竖杆共用 */}
    <path
      d="M53 16V84"
      stroke="currentColor"
      strokeWidth={MARK_STEM_WIDTH}
      strokeLinecap="round"
    />
    {/* D 的碗形 */}
    <path
      d="M53 16A34 34 0 0 1 53 84"
      stroke="currentColor"
      strokeWidth={MARK_STEM_WIDTH}
      strokeLinecap="round"
    />
    {/* J 的钩形：自主脊向左回卷，底部与 D 的底边齐平 */}
    <path
      d="M53 64A20 20 0 1 1 18.86 49.86"
      stroke={mono ? "currentColor" : BRAND_ACCENT}
      strokeWidth={MARK_STEM_WIDTH}
      strokeLinecap="round"
    />
  </svg>
);

export default Logo;
