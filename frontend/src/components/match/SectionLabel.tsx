import type { ReactNode } from "react";

interface SectionLabelProps {
  /** 编辑式步骤序号（等宽数字，纯装饰） */
  no: string;
  children: ReactNode;
}

/**
 * 控制台分组标题（Paper & Punch 编辑式节奏）。
 *
 * 配置区原本是一串等宽圆角卡片垂直堆叠，缺少分节锚点；这里用
 *「等宽序号 + 中文小标签 + 延伸到右侧的细线」建立层级，让每一组
 * 有明确的起点，而不是靠间距差去猜分组。
 *
 * 中文标签必须走 .eb-zh：正文体、10.5px、600、零字距、不转大写。
 * 序号是数字，可以用 mono + tabular-nums，不会拉散汉字。
 */
export default function SectionLabel({ no, children }: SectionLabelProps) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-[10px] font-bold leading-none tabular-nums text-cobalt"
      >
        {no}
      </span>
      <span className="eb-zh shrink-0 text-ink-2">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}
