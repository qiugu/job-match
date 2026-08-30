// 后端地址：拆分出来是为了让 auth.ts 与 jobmatch.ts 共用，避免二者互相 import。
// 经 Nginx 同源代理时，VITE_JOBMATCH_API 置空，API_BASE 为空串即「相对路径」，
// fetch('/api/...') 会基于当前页面同源发起，无需跨域、也无需直连后端端口。
const rawApi = import.meta.env.VITE_JOBMATCH_API as string | undefined;
export const API_BASE = rawApi && rawApi.trim() ? rawApi.trim().replace(/\/$/, "") : "";
