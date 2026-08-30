import { createFileRoute } from "@tanstack/react-router";

const BACKEND_BASE =
  import.meta.env.VITE_JOBMATCH_API?.trim()
    ? import.meta.env.VITE_JOBMATCH_API.trim().replace(/\/$/, "")
    : ""; // 空串=同源相对路径（经 Nginx 反向代理）

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

          // 后端 AI 接口要求登录（每次调用消耗 LLM 额度）：把浏览器请求里的
          // 令牌原样转发给 Python 后端，未登录直接在代理层拒绝。
          const authorization = request.headers.get("authorization");
          if (!authorization) {
            return Response.json(
              { error: { message: "未登录或登录状态已失效" } },
              { status: 401 }
            );
          }

          // 透传给 Python 后端 AI 代理，由后端持有 api_key 调用大模型
          const upstream = await fetch(`${BACKEND_BASE}/api/ai/grammar`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authorization },
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
