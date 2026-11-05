/**
 * 可观测性面板的共享原语：KPI 卡与图表面板容器。
 *
 * 抽取原因（PLAN_unified_observability）：匹配与翻译观测合并为统一可观测性页后，
 * 所有面板必须共用同一套卡片原语，否则字号/留白一有偏差就会被读成「两个页面」。
 * 独立成文件避免组件间交叉导入。
 */
export function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="workbench-panel analytics-kpi analytics-panel p-5">
      <p className="xai-eyebrow text-[10px]">{label}</p>
      <p className="mt-2 font-mono text-[28px] font-semibold leading-none tracking-[-0.06em] text-xai-text">
        {value}
      </p>
      {hint && (
        <p className="mt-3 truncate text-[11px] leading-5 text-xai-mute">{hint}</p>
      )}
    </div>
  );
}

/** 图表/列表容器卡。 */
export function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="workbench-panel analytics-panel p-5">
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        <p className="xai-eyebrow text-[10px]">{title}</p>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
