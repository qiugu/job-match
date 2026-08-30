import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  (import.meta.env.VITE_JOBMATCH_API || "http://localhost:7001").replace(/\/$/, "");

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

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型。
          // 后端先从 PDF 提取纯文本再交给纯文本模型，避免依赖图片（多模态）模型。
          const upstreamForm = new FormData();
          upstreamForm.append("file", file);
          upstreamForm.append("locale", locale);

          const upstream = await fetch(`${BACKEND_BASE}/api/ai/resume-import-pdf`, {
            method: "POST",
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
