import { createFileRoute, redirect } from "@tanstack/react-router"

// 旧路径兼容（PLAN_guest_access P1）：模板预览已迁出登录墙到 /templates/$id，
// 旧链接（含快照脚本的 ?locale=&snapshot=1）在这里 1:1 透传重定向。
// 注意：/app 布局守卫对 preview-template 路径做了豁免（见 routes/app/route.tsx），
// 否则未登录用户会在重定向前被踢到登录页。
export const Route = createFileRoute('/app/preview-template/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/templates/$id",
      params: { id: params.id },
    })
  },
})
