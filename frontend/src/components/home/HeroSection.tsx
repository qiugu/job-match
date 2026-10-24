import { useTranslations } from "@/i18n/compat/client";
import { Sparkles, ArrowRight, Play } from "lucide-react";
import AnimatedFeature from "./client/AnimatedFeature";
import GoDashboard from "./GoDashboard";
import Image from "@/lib/image";

export default function HeroSection() {
  const t = useTranslations("home");

  return (
    <section className="relative min-h-[90vh] flex flex-col items-center justify-center pt-32 pb-20 overflow-hidden bg-paper">
      {/* 纸面点阵纹理：Paper & Punch 的氛围层，不用 blur 光斑 */}
      <div className="pp-dotgrid" aria-hidden="true" />

      {/* 撞色块：左上橘色小方块 + 右下薄荷绿方块，全屏撞色面积 ≤ 10% */}
      <div className="pointer-events-none absolute left-[6%] top-[22%] hidden h-16 w-16 rotate-6 border-2 border-ink bg-tangerine lg:block" aria-hidden="true" />
      <div className="pointer-events-none absolute right-[8%] bottom-[18%] hidden h-10 w-10 -rotate-3 rounded-full border-2 border-ink bg-mint lg:block" aria-hidden="true" />

      <div className="container relative z-10 mx-auto px-6 text-center max-w-4xl">
        <AnimatedFeature>
          <div className="mb-10 inline-flex items-center gap-2 rounded-full border-2 border-ink bg-butter px-4 py-1.5 text-sm font-semibold text-ink">
            <Sparkles className="w-4 h-4" />
            <span className="tracking-wide">{t("hero.badge")}</span>
          </div>

          <h1 className="font-display text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.05] mb-8 text-ink">
            {t("hero.title")}
          </h1>

          <p className="text-xl md:text-2xl text-ink-2 mb-12 max-w-2xl mx-auto leading-relaxed">
            {t("hero.subtitle")}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
            <GoDashboard>
              <button
                type="button"
                className="pp-btn group h-14 px-10 text-lg"
              >
                {t("hero.cta")}
                <ArrowRight className="w-5 h-5 ml-1 transition-transform group-hover:translate-x-1" />
              </button>
            </GoDashboard>

            <GoDashboard type="templates">
              <button
                type="button"
                className="pp-btn pp-btn--ghost h-14 px-10 text-lg"
              >
                <Play className="w-4 h-4 mr-1 fill-current" />
                {t("hero.secondary")}
              </button>
            </GoDashboard>
          </div>
        </AnimatedFeature>

        <AnimatedFeature delay={0.3}>
          <div className="mt-20 relative px-4 sm:px-0">
            {/* 硬偏移阴影相框：产品图是「贴」在纸上的，不是浮在雾里 */}
            <div className="relative rounded-2xl border-2 border-ink bg-ppcard p-2 sm:p-3 shadow-punch">
              {/*
                首屏 LCP 图片：原为单张 2560×1440 / 326KB 的 jpg，手机端也下载全量。
                改为 AVIF → WebP → jpg 三级回退 + 两档宽度（产物由
                scripts/generate-hero-images.mjs 生成）：
                1200w 的 avif 仅 25KB，比原图省约 92%。
                fetchpriority=high 让浏览器把它排在预载队列最前；width/height 保留
                以避免布局抖动（CLS）。
              */}
              <picture>
                <source
                  type="image/avif"
                  sizes="(max-width: 1024px) 100vw, 1200px"
                  srcSet="/web-shot-1200.avif 1200w, /web-shot-1920.avif 1920w"
                />
                <source
                  type="image/webp"
                  sizes="(max-width: 1024px) 100vw, 1200px"
                  srcSet="/web-shot-1200.webp 1200w, /web-shot-1920.webp 1920w"
                />
                <Image
                  src="/web-shot.jpg"
                  alt={t("hero.imageAlt")}
                  width={1200}
                  height={800}
                  className="rounded-xl border border-line"
                  fetchpriority="high"
                  decoding="async"
                  priority
                />
              </picture>
            </div>
          </div>
        </AnimatedFeature>
      </div>
    </section>
  );
}
