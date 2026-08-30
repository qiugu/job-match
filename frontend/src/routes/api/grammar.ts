import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  (import.meta.env.VITE_JOBMATCH_API || "http://localhost:7001").replace(/\/$/, "");

export const Route = createFileRoute("/api/grammar")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { content } = body as { content: string };

          if (!content || !content.trim()) {
            return Response.json({
              choices: [
                { message: { content: JSON.stringify({ errors: [] }) } },
              ],
            });
          }

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型
          const upstream = await fetch(`${BACKEND_BASE}/api/ai/grammar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });

          const raw = await upstream.text();
          if (!upstream.ok) {
            let message = raw || `Upstream error: ${upstream.status}`;
            try {
              const data = JSON.parse(raw);
              message = data.error?.message || data.error || message;
            } catch {
              /* ignore */
            }
            return Response.json(
              { error: { message } },
              { status: upstream.status || 502 }
            );
          }

          try {
            return Response.json(JSON.parse(raw));
          } catch {
            return Response.json(
              { error: { message: "Invalid upstream response" } },
              { status: 502 }
            );
          }
        } catch (error) {
          console.error("Grammar proxy error:", error);
          return Response.json(
            { error: { message: error instanceof Error ? error.message : "Grammar check failed" } },
            { status: 500 }
          );
        }
      },
    },
  },
});
