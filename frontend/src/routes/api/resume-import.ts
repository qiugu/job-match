import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  (import.meta.env.VITE_JOBMATCH_API || "http://localhost:7001").replace(/\/$/, "");

export const Route = createFileRoute("/api/resume-import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { content, images, locale } = body as {
            content?: string;
            images?: string[];
            locale?: string;
          };

          if (!content && (!images || images.length === 0)) {
            return Response.json(
              { error: "Missing resume content or images" },
              { status: 400 }
            );
          }

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型
          const upstream = await fetch(`${BACKEND_BASE}/api/ai/resume-import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, images: images || [], locale }),
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
          console.error("Resume import proxy error:", error);
          return Response.json(
            { error: error instanceof Error ? error.message : "Resume import failed" },
            { status: 500 }
          );
        }
      },
    },
  },
});
