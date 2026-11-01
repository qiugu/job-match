import { ArrowRight } from "lucide-react";
import { useTranslations } from "@/i18n/compat/client";
import AnimatedFeature from "./client/AnimatedFeature";
import GoDashboard from "./GoDashboard";
import GoTryEditor from "./GoTryEditor";

export default function CTASection() {
  const t = useTranslations("home");

  return (
    <section className="relative overflow-hidden flex items-center justify-center min-h-[70vh] bg-ink">
      {/* 巨型背景字：墨版纸上唯一的「印刷感」装饰，不用渐变网格 */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none opacity-[0.07]">
        <div className="text-[20vw] md:text-[18vw] font-display font-black text-paper whitespace-nowrap leading-[0.8] tracking-tighter">
          JDMATCH
        </div>
      </div>
      <div className="pp-dotgrid opacity-[0.05]" aria-hidden="true" />

      <div className="container mx-auto px-6 relative z-10 text-center">
        <AnimatedFeature>
          <div className="flex flex-col items-center max-w-4xl mx-auto">
            <h2 className="text-5xl md:text-7xl font-display font-extrabold tracking-tight text-paper mb-8 leading-[1.06]">
              {t("cta.title")}
            </h2>

            <p className="text-xl md:text-2xl text-paper/80 mb-16 max-w-2xl leading-relaxed">
              {t("cta.description")}
            </p>

            <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
              <GoDashboard>
                <button
                  type="submit"
                  className="pp-btn h-16 px-12 text-xl bg-butter text-ink border-2 border-paper hover:bg-paper group"
                >
                  {t("cta.button")}
                  <ArrowRight className="w-6 h-6 ml-2 transition-transform group-hover:translate-x-1.5" />
                </button>
              </GoDashboard>
              {/* 游客试用入口（PLAN_guest_access）：编辑器对未登录全开放，
                  这是「价值前置」的主转化路径之一。
                  ⚠ 必须是 type="submit"：GoTryEditor 靠 <form onSubmit> 跳转，
                  此前误写成 type="button" 导致按钮完全无法点击（2026-10-31 修复）。 */}
              <GoTryEditor>
                <button
                  type="submit"
                  className="pp-btn group h-16 px-12 text-xl bg-transparent text-paper border-paper/70 hover:bg-paper hover:text-ink hover:border-paper"
                >
                  {t("cta.tryButton")}
                  <ArrowRight className="w-6 h-6 ml-2 transition-transform group-hover:translate-x-1.5" />
                </button>
              </GoTryEditor>
            </div>

          </div>
        </AnimatedFeature>
      </div>
    </section>
  );
}
