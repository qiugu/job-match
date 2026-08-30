import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  import.meta.env.VITE_JOBMATCH_API?.trim()
    ? import.meta.env.VITE_JOBMATCH_API.trim().replace(/\/$/, "")
    : ""; // 空串=同源相对路径（经 Nginx 反向代理）

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

          // 后端 AI 接口要求登录（每次调用消耗 LLM 额度）：把浏览器请求里的
          // 令牌原样转发给 Python 后端，未登录直接在代理层拒绝。
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            return Response.json(
              { error: "未登录或登录状态已失效" },
              { status: 401 }
            );
          }

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型
          const upstream = await fetch(`${BACKEND_BASE}/api/ai/polish`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authorization },
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
