/**
 * 公开模板画廊（/templates）。
 *
 * PLAN_guest_access P1：模板展示从登录墙内迁出，作为可索引的 SEO 获客入口。
 * 卡片直接使用构建期生成的模板快照 PNG（src/generated/templateSnapshotManifest），
 * 不在列表页渲染 9 份完整简历模板，保证页面轻量。
 * CTA：未登录 → /edit?template=id（游客编辑器）；已登录同样进入编辑器，
 * 由 /edit 路由守卫重定向到控制台。
 */

import { useLocale, useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { getMarkdownTemplate } from "@/config";
import { useTemplateSnapshots } from "@/hooks/useTemplateSnapshots";
import { trackGrowthEvent } from "@/lib/telemetry";
import { ArrowRight, Eye } from "lucide-react";

export default function PublicTemplateGallery() {
  const t = useTranslations("dashboard.templates");
  const tGallery = useTranslations("templatesGallery");
  const locale = useLocale();
  const router = useRouter();
  const { snapshotMap } = useTemplateSnapshots(locale);

  const goPreview = (templateId: string) => {
    void trackGrowthEvent("cta_click", { path: "/templates" });
    router.push({
      to: "/templates/$id",
      params: { id: templateId }
    });
  };

  return (
    <main className="min-h-screen bg-paper" data-density="calm">
      <div className="container mx-auto max-w-6xl px-6 py-14">
        <header className="text-center">
          <p className="eb-zh text-[12px] font-semibold uppercase tracking-normal text-cobalt">
            {tGallery("badge")}
          </p>
          <h1 className="mt-3 font-display text-4xl font-extrabold tracking-tight text-ink md:text-5xl">
            {tGallery("title")}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">
            {tGallery("subtitle")}
          </p>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {DEFAULT_TEMPLATES.map((template) => {
            // 视觉模板 id 与 Markdown 模板 id 同名（left-right 除外），
            // 名称/描述统一走 i18n 的 dashboard.templates 命名空间
            const nameKey = getMarkdownTemplate(template.id).nameKey;
            const snapshot = snapshotMap[template.id];
            return (
              <article
                key={template.id}
                className="pp-card group flex flex-col overflow-hidden bg-white"
              >
                <button
                  type="button"
                  onClick={() => goPreview(template.id)}
                  className="relative block aspect-[210/297] w-full cursor-zoom-in overflow-hidden border-b border-line bg-white"
                  aria-label={`${t("preview")} · ${t(`${nameKey}.name`)}`}
                >
                  {snapshot ? (
                    <img
                      src={snapshot}
                      alt={`${t(`${nameKey}.name`)} ${tGallery("templatePreviewAlt")}`}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <span className="eb-zh absolute inset-0 grid place-items-center text-ink-3">
                      {tGallery("templatePreviewMissing")}
                    </span>
                  )}
                  <span className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-paper px-3 py-1 text-[11.5px] font-medium text-ink-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <Eye className="h-3 w-3" />
                    {t("preview")}
                  </span>
                </button>

                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div>
                    <h2 className="font-display text-[17px] font-bold text-ink">
                      {t(`${nameKey}.name`)}
                    </h2>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
                      {t(`${nameKey}.description`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void trackGrowthEvent("cta_click", {
                        path: `/templates/use/${template.id}`
                      });
                      router.push({
                        to: "/edit",
                        search: { template: template.id }
                      });
                    }}
                    className="pp-btn mt-auto w-full"
                  >
                    {t("useTemplate")}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}
