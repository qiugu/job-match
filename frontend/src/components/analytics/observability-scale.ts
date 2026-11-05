/**
 * 统一可观测性（traces/spans）的**纯函数**工具层：节点耗时分布、错误归因、成本归因。
 *
 * 与 scale.ts / matching-scale.ts 同思路：与渲染分离、node 可测，承载最易算错的逻辑。
 */
import type {
  ObservabilityNode,
  ObservabilityTraceSummary,
} from "@/lib/jobmatch";

/** 节点成功率：total 为 0 时返回 0，避免 NaN。 */
export function nodeSuccessRate(node: ObservabilityNode): number {
  return node.calls > 0 ? node.success / node.calls : 0;
}

/** 每日调用量最大值（柱状图缩放用），空数据兜底为 1。 */
export function observabilityDailyMax(values: number[]): number {
  return Math.max(1, ...values.filter(Number.isFinite));
}

/**
 * 每日趋势图 X 轴标签的抽样步长。
 *
 * 180 天窗口有 180 根柱子，若每根都渲染 MM-DD 标签，文字会互相压叠成一条黑带；
 * 这里把可见标签数压到 maxLabels 以内（7 天窗口 step=1 仍全显示）。
 */
export function dailyLabelStep(count: number, maxLabels = 12): number {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(1, maxLabels)));
}

/** 端点维度分布总数（用于占比条）。 */
export function endpointTotal(
  endpoints: Array<{ calls: number }>
): number {
  return endpoints.reduce((sum, e) => sum + e.calls, 0);
}

/** 节点 token 归因总数（成本面板）。 */
export function costNodeTotal(
  byNode: Array<{ total_tokens: number }>
): number {
  return byNode.reduce((sum, n) => sum + n.total_tokens, 0);
}

/** 错误类型分布：把 [type, count] 元组转成可展示的排序列表。 */
export function errorTypeDistribution(
  node: ObservabilityNode
): Array<{ type: string; count: number }> {
  return (node.error_types || [])
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

/** 节点标签：把后端 step_key 映射为可读文案（缺翻译时回退原始 key）。 */
export function nodeLabel(
  stepKey: string,
  t: (key: string) => string
): string {
  const key = `observabilityNode.${stepKey}`;
  const label = t(key);
  return label === key ? stepKey : label;
}

/** 端点标签：把后端 endpoint 映射为可读文案。
 *
 * 注意：i18n 的 t() 按 "." 拆嵌套路径，因此 locales 里的
 * observabilityEndpoint 必须写成 { ai: { translate, polish, ... }, jd: {...} }，
 * 不能用扁平的 "ai.translate" 键——后者永远查不到，会静默回退成英文端点名。
 */
export function endpointLabel(
  endpoint: string,
  t: (key: string) => string
): string {
  const key = `observabilityEndpoint.${endpoint}`;
  const label = t(key);
  return label === key ? endpoint : label;
}

/** 最近 trace 的摘要文本（用于列表行主标题）。 */
export function traceSummaryText(
  trace: ObservabilityTraceSummary,
  t: (key: string) => string
): string {
  return `${endpointLabel(trace.endpoint, t)} · ${trace.started_at?.slice(5, 16).replace("T", " ") || "—"}`;
}

/** 可观测性内容区的渲染状态。
 *
 * 组件据此切换「内容区」，而能力维度切换条始终常驻——筛选到无数据的维度时
 * 不能把切换条一起卸载，否则用户无法切回「全部」。
 *
 * - total === null 表示当前还没有拿到本轮筛选的数据（请求中 / 尚未加载）。
 * - error 只在没有可用数据时升级为错误态；请求失败不会用上一维度的数据冒充当前结果。
 * - filtered 区分「全站无数据」与「当前维度无数据」，后者要额外提供返回入口。
 */
export type ObservabilityViewState =
  | "loading"
  | "error"
  | "empty-all"
  | "empty-filtered"
  | "ready";

export function observabilityViewState(args: {
  loading: boolean;
  error: boolean;
  total: number | null;
  filtered: boolean;
}): ObservabilityViewState {
  const { loading, error, total, filtered } = args;
  if (error && total === null) return "error";
  if (loading || total === null) return "loading";
  if (total === 0) return filtered ? "empty-filtered" : "empty-all";
  return "ready";
}
