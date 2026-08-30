import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  import.meta.env.VITE_JOBMATCH_API?.trim()
    ? import.meta.env.VITE_JOBMATCH_API.trim().replace(/\/$/, "")
    : ""; // 空串=同源相对路径（经 Nginx 反向代理）

export const Route = createFileRoute("/api/resume-import-pdf")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const form = await request.formData();
          const file = form.get("file");
          const locale = (form.get("locale") as string | null) || "zh";

          if (!file || typeof file === "string") {
            return Response.json(
              { error: "Missing PDF file" },
              { status: 400 }
            );
          }

          // 后端 AI 接口要求登录（每次调用消耗 LLM 额度）：把浏览器请求里的
          // 令牌原样转发给 Python 后端，未登录直接在代理层拒绝。
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            return Response.json(
              { error: "未登录或登录状态已失效" },
              { status: 401 }
            );
          }

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型。
          // 后端先从 PDF 提取纯文本再交给纯文本模型，避免依赖图片（多模态）模型。
          const upstreamForm = new FormData();
          upstreamForm.append("file", file);
          upstreamForm.append("locale", locale);

          const upstream = await fetch(`${BACKEND_BASE}/api/ai/resume-import-pdf`, {
            method: "POST",
            headers: { Authorization: authorization },
            body: upstreamForm,
          });

          const raw = await upstream.text();
          if (!upstream.ok) {
            let message = raw || `Upstream error: ${upstream.status}`;
            try {
              const data = JSON.parse(raw);
              message = data.error || message;
            } catch {
              /* ignore */
            }
            return Response.json(
              { error: message },
              { status: upstream.status || 502 }
            );
          }

          try {
            return Response.json(JSON.parse(raw));
          } catch {
            return Response.json(
              { error: "Invalid upstream response" },
              { status: 502 }
            );
          }
        } catch (error) {
          console.error("Resume import PDF proxy error:", error);
          return Response.json(
            { error: error instanceof Error ? error.message : "Resume import failed" },
            { status: 500 }
          );
        }
      },
    },
  },
});
