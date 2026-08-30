import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  (import.meta.env.VITE_JOBMATCH_API || "http://localhost:7001").replace(/\/$/, "");

export const Route = createFileRoute("/api/polish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { content, customInstructions } = body as {
            content: string;
            customInstructions?: string;
          };

          if (!content || !content.trim()) {
            return new Response("", { status: 200 });
          }

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型
          const upstream = await fetch(`${BACKEND_BASE}/api/ai/polish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, customInstructions }),
          });

          if (!upstream.ok || !upstream.body) {
            const msg = await upstream.text().catch(() => "");
            return Response.json(
              { error: msg || `Upstream error: ${upstream.status}` },
              { status: upstream.status || 502 }
            );
          }

          return new Response(upstream.body, {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        } catch (error) {
          console.error("Polish proxy error:", error);
          return Response.json(
            { error: error instanceof Error ? error.message : "Polish failed" },
            { status: 500 }
          );
        }
      },
    },
  },
});
