import * as React from "react";

/**
 * xAI 风格线性图标
 * - 24px 网格、1.7 描边、圆头圆角
 * - 统一 currentColor，颜色跟随父级文字色（深色底上用 text-white / text-xai-mute）
 * - 只做描边不做填充，避免与深色 hairline 分层体系冲突
 */
export interface XaiIconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

const svgProps = (size: number, className?: string, strokeWidth = 1.7) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
});

/** 靶心 —— 简历匹配 */
export const IconTarget = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/** 文档 —— 我的简历 */
export const IconDoc = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
    <path d="M13.5 3v5.5H19" />
    <path d="M8.75 13h6.5M8.75 16.5h4.5" />
  </svg>
);

/** 栅格 —— 简历模板 */
export const IconGrid = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </svg>
);

/** 加号 —— 新建 */
export const IconPlus = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** 上传 —— 上传 PDF 简历 */
export const IconUpload = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M12 15.5V4.5" />
    <path d="M7.5 9 12 4.5 16.5 9" />
    <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
  </svg>
);

/** 下载 —— 导出 */
export const IconDownload = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M12 4.5v11" />
    <path d="M7.5 11 12 15.5 16.5 11" />
    <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
  </svg>
);

/** 关闭 */
export const IconX = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

/** 对勾 */
export const IconCheck = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </svg>
);

/** 向下箭头 / 展开 */
export const IconChevronDown = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M6 9.5 12 15.5 18 9.5" />
  </svg>
);

/** 向右箭头 */
export const IconChevronRight = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M9.5 6 15.5 12 9.5 18" />
  </svg>
);

/** 返回 */
export const IconArrowLeft = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M19 12H5" />
    <path d="M11 6 5 12l6 6" />
  </svg>
);

/** 保存 */
export const IconSave = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M5 4.5h11L19.5 8v11a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z" />
    <path d="M8 4.5v5h7v-5" />
    <rect x="8" y="13.5" width="8" height="7" rx="1" />
  </svg>
);

/** 预览 / 可见 */
export const IconEye = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** 撤销 */
export const IconUndo = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
    <path d="M7.5 5.5 4 9l3.5 3.5" />
  </svg>
);

/** 重做 */
export const IconRedo = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H16" />
    <path d="M16.5 5.5 20 9l-3.5 3.5" />
  </svg>
);

/** 登出 */
export const IconLogout = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14" />
    <path d="M17 8.5 20.5 12 17 15.5" />
    <path d="M20 12h-9" />
  </svg>
);

/** 刷新 / 重新匹配 */
export const IconRefresh = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M20 5.5v5h-5" />
    <path d="M19.5 10.5A8 8 0 1 0 20 14" />
  </svg>
);

/** Markdown / 代码 */
export const IconCode = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M8.5 7 4 12l4.5 5" />
    <path d="M15.5 7 20 12l-4.5 5" />
  </svg>
);

/** 无序列表 */
export const IconList = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="17.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/** 有序列表 */
export const IconListOrdered = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" />
    <path d="M3.5 5.5h1.5v3" />
    <path d="M3.5 11h2l-2 2.5h2" />
    <path d="M3.5 16.5h2v2.5H3.5z" />
  </svg>
);

/** 复制 */
export const IconCopy = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1" />
  </svg>
);

/** 搜索 */
export const IconSearch = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </svg>
);

/** 编辑 / 改写 */
export const IconPen = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M16.5 4.5l3 3L9 18l-4 1 1-4z" />
    <path d="M14 7l3 3" />
  </svg>
);

/** 删除 */
export const IconTrash = ({ size = 20, className, strokeWidth }: XaiIconProps) => (
  <svg {...svgProps(size, className, strokeWidth)}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
    <path d="M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12" />
    <path d="M10.5 11v6M13.5 11v6" />
  </svg>
);
