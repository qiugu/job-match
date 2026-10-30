import { createFileRoute } from "@tanstack/react-router";

import PublicTemplateGallery from "@/components/templates/PublicTemplateGallery";
import { absoluteUrl, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH, SITE_NAME } from "@/lib/seo/site";

// 公开可索引页（PLAN_guest_access P1）：模板画廊是 SEO 获客入口，
// 与登录态的 /app/* 相反，这里必须 index,follow。
export const Route = createFileRoute("/templates/")({
  head: () => {
    const title = "免费简历模板 - 在线编辑与导出 | JDMatch";
    const description =
      "9 套专业简历模板：经典、商务、时间轴、极简、衬线等版式即选即用，" +
      "无需注册即可在线编辑，登录后可保存云端并导出 PDF。";
    const ogImage = absoluteUrl(OG_IMAGE_PATH);

    return {
      meta: [
        { title },
        { name: "description", content: description },
        { name: "robots", content: "index,follow,max-image-preview:large" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: SITE_NAME },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: absoluteUrl("/templates") },
        { property: "og:image", content: ogImage },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: String(OG_IMAGE_WIDTH) },
        { property: "og:image:height", content: String(OG_IMAGE_HEIGHT) },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "twitter:image", content: ogImage }
      ],
      links: [{ rel: "canonical", href: absoluteUrl("/templates") }]
    };
  },
  component: PublicTemplateGallery
});
