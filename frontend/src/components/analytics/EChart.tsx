/**
 * ECharts 通用封装：初始化 / 重绘 / 尺寸自适应 / 主题跟随 / 卸载释放。
 *
 * 三个必须由封装层统一处理的点：
 * 1. **主题跟随**——本项目主题是 `html` 上的 `light` / `dark` class（next-themes 驱动），
 *    而 ECharts 画在 Canvas 上、读不到 CSS 变量。因此这里在挂载后与
 *    `<html>` class 变化时重新解析 `.theme-xai` 令牌，并以新令牌重建 option。
 *    仅监听 class 属性，不做轮询。
 * 2. **尺寸自适应**——用 `ResizeObserver`（侧栏折叠、窗口缩放都会改变容器宽度）。
 * 3. **动效降级**——`prefers-reduced-motion: reduce` 时整体关闭动画。
 *    入场动画只是装饰，不应成为前庭敏感用户的不适来源。
 */
import { useEffect, useRef, useState } from "react";

import * as echarts from "echarts/core";
import { BarChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";

import { cn } from "@/lib/utils";

import { readChartTokens, type ChartTokens } from "./tokens";

// 按需注册：只引入用到的图表与组件，避免把整包 echarts（约 1MB）打进产物。
// 注意 markArea 需要单独注册 MarkAreaComponent，否则「回填日」色带不会渲染。
echarts.use([
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);

/** 感知系统「减少动态效果」偏好，并在其变化时同步。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export interface EChartProps {
  /** 容器高度（px）。ECharts 需要有确定尺寸的宿主元素。 */
  height: number;
  /** 无障碍标签：必须描述图表表达的内容，而非「一个图表」。 */
  ariaLabel: string;
  /**
   * 数据版本号。数据变化时改变它即可触发重绘。
   * 刻意不用依赖数组展开：option 由 `build` 从最新闭包构造，
   * 用显式版本号可避免「闭包过期」与 lint 对展开依赖的告警。
   */
  revision: string | number;
  /** 用当前主题令牌构造 option（主题切换时会被再次调用）。 */
  build: (tokens: ChartTokens) => EChartsOption;
  className?: string;
}

export function EChart({
  height,
  ariaLabel,
  revision,
  build,
  className,
}: EChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const reducedMotion = usePrefersReducedMotion();
  /** 挂载后才可能解析令牌（非 DOM 环境拿不到真实色值） */
  const [tokens, setTokens] = useState<ChartTokens | null>(null);

  // 1) 初始化 + 尺寸自适应 + 卸载释放
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const instance = echarts.init(host, undefined, { renderer: "canvas" });
    chartRef.current = instance;
    setTokens(readChartTokens(host));

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => instance.resize())
        : null;
    observer?.observe(host);

    return () => {
      observer?.disconnect();
      // 释放 canvas 与内部事件监听，避免路由切换后实例泄漏
      instance.dispose();
      chartRef.current = null;
    };
  }, []);

  // 2) 主题切换（<html> 的 class 变化）→ 重新解析令牌 → 触发下方重绘
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      setTokens(readChartTokens(hostRef.current));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // 3) 数据或主题变化 → 重绘
  useEffect(() => {
    const instance = chartRef.current;
    if (!instance || !tokens) return;
    const option = buildRef.current(tokens);
    instance.setOption(
      reducedMotion ? ({ ...option, animation: false } as EChartsOption) : option,
      { notMerge: true }
    );
    // 首次挂载时容器可能尚未完成布局，重绘后补一次尺寸计算
    instance.resize();
  }, [tokens, revision, reducedMotion]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={ariaLabel}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}
