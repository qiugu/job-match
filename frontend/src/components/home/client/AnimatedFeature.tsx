"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface AnimatedFeatureProps {
  children: ReactNode;
  delay?: number;
}

/**
 * 入场动画（渐进增强）。
 *
 * 原实现用 framer-motion 的 `initial={{opacity:0}}` + `whileInView`，
 * 会把 opacity:0 写进 SSR HTML：不滚动（整页截图、打印、爬虫、
 * 禁用 JS）时内容永久空白。现改为：
 *
 * 1. CSS 默认可见（`html.js` 类不存在时无任何隐藏）；
 * 2. 客户端挂载后才给 <html> 加 `js` 类进入「待入场」态；
 * 3. IntersectionObserver 触发后打 `data-shown="true"` 播放过渡；
 * 4. `prefers-reduced-motion` 与 `@media print` 下强制可见。
 *
 * 相关规则见 globals.css 的 .rv-guard 段。
 */
export default function AnimatedFeature({ children, delay = 0 }: AnimatedFeatureProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add("js");

    const el = ref.current;
    if (!el) return;

    // 不支持 IO 的老浏览器：直接显示，不做动画
    if (!("IntersectionObserver" in window)) {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.06, rootMargin: "0px 0px -6% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="rv-guard"
      data-shown={shown ? "true" : "false"}
      style={{ transitionDelay: `${delay}s` }}
    >
      {children}
    </div>
  );
}
