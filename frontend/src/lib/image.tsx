import { CSSProperties, forwardRef, ImgHTMLAttributes } from "react";

type ImageLikeSource = string | { src: string };

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: ImageLikeSource;
  fill?: boolean;
  priority?: boolean;
  // React 18 的类型定义尚未内置 fetchpriority（React 19 才有），但浏览器已支持，
  // 且未知属性会原样输出到 DOM，故在此显式声明以便 LCP 图提升加载优先级。
  fetchpriority?: "high" | "low" | "auto";
};

const Image = forwardRef<HTMLImageElement, Props>(function Image(
  { src, alt, fill, style, priority, ...rest },
  ref
) {
  const resolvedSrc = typeof src === "string" ? src : src.src;
  const mergedStyle: CSSProperties = fill
    ? {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        ...style
      }
    : style || {};

  return (
    <img
      ref={ref}
      src={resolvedSrc}
      alt={alt || ""}
      loading={priority ? "eager" : "lazy"}
      style={mergedStyle}
      {...rest}
    />
  );
});

export default Image;
