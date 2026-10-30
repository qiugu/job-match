/**
 * 公开模板预览页的外壳（PLAN_guest_access P1）。
 *
 * 中间是真实的模板渲染（复用 IframeTemplateViewer，snapshot=1 时由
 * /templates/$id 路由直接裸渲染，此外壳不参与快照）。顶部提供返回画廊
 * 与「使用该模板」CTA：未登录进入游客编辑器，已登录被 /edit 守卫
 * 重定向到控制台。
 */

import { useTranslations } from "@/i18n/compat/client";
import { useRouter } from "@/lib/navigation";
import IframeTemplateViewer from "@/components/preview/IframeTemplateViewer";
import { trackGrowthEvent } from "@/lib/telemetry";
import { ArrowLeft, ArrowRight } from "lucide-react";

interface TemplatePreviewChromeProps {
  templateId: string;
}

export default function TemplatePreviewChrome({
  templateId,
}: TemplatePreviewChromeProps) {
  const t = useTranslations("dashboard.templates");
  const tGallery = useTranslations("templatesGallery");
  const router = useRouter();

  return (
    <div className="flex min-h-screen flex-col bg-paper-2">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-paper px-4">
        <button
          type="button"
          onClick={() => router.push({ to: "/templates" })}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-paper hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
          {tGallery("backToGallery")}
        </button>
        <button
          type="button"
          className="pp-btn"
          onClick={() => {
            void trackGrowthEvent("cta_click", {
              path: `/templates/${templateId}/use`
            });
            router.push({
              to: "/edit",
              search: { template: templateId }
            });
          }}
        >
          {t("useTemplate")}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-auto py-8">
        <IframeTemplateViewer />
      </div>
    </div>
  );
}
