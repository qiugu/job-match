import { createFileRoute } from "@tanstack/react-router";

import IframeTemplateViewer from "@/components/preview/IframeTemplateViewer";
import TemplatePreviewChrome from "@/components/templates/TemplatePreviewChrome";
import { absoluteUrl } from "@/lib/seo/site";

// 公开可索引页（PLAN_guest_access P1）：单模板预览。
// snapshot=1 时由快照脚本抓取纯净画面（无 chrome），其余场景带顶栏与 CTA。
export const Route = createFileRoute("/templates/$id")({
  ssr: false,
  head: () => {
    const title = "简历模板预览 - JDMatch";
    return {
      meta: [
        { title },
        // 单模板预览页内容重复度高（与画廊重叠），只收录画廊，本页不索引
        { name: "robots", content: "noindex,follow" }
      ],
      links: [{ rel: "canonical", href: absoluteUrl("/templates") }]
    };
  },
  component: TemplatePreviewRoute
});

function TemplatePreviewRoute() {
  const { id } = Route.useParams();
  const isSnapshot =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("snapshot") === "1";

  if (isSnapshot) {
    return <IframeTemplateViewer />;
  }

  return <TemplatePreviewChrome templateId={id} />;
}
