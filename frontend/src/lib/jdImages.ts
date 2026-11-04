/**
 * JD 截图上传的纯逻辑层（无 DOM 依赖，可直接跑 node 单测）。
 *
 * 常量与后端 app/services/jd_images.py 一一对应，改动必须两端同步：
 * 后端只接受 data URL，外链图片由前端经 /image-proxy 抓取后转换，
 * 从而把 SSRF 面收在既有的图片代理内，而不是扩散到匹配接口。
 */

/** 最多可附加的 JD 截图数量 */
export const MAX_JD_IMAGES = 4;
/** 单张图片解码后允许的最大字节数 */
export const MAX_JD_IMAGE_BYTES = 4 * 1024 * 1024;
/** 一次请求所有图片解码后的总字节上限 */
export const MAX_JD_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
/** 后端同样按此白名单校验；SVG 被排除（可执行脚本载体） */
export const ALLOWED_JD_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type JdImageSource = "file" | "paste" | "url";

export interface JdImageItem {
  id: string;
  dataUrl: string;
  name: string;
  source: JdImageSource;
}

export type JdImageRejectReason =
  | "format"
  | "type"
  | "empty"
  | "size"
  | "invalid-base64";

export type ValidateJdImageResult =
  | { ok: true; mime: string; bytes: number }
  | { ok: false; reason: JdImageRejectReason };

/** 由 base64 长度精确反推解码后字节数（含 padding 修正），无需 atob。 */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

/** 校验单个 data URL 的格式、MIME、base64 合法性与体积。 */
export function validateJdImage(dataUrl: string): ValidateJdImageResult {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return { ok: false, reason: "format" };
  }
  const matched = DATA_URL_RE.exec(dataUrl);
  if (!matched) {
    return { ok: false, reason: "invalid-base64" };
  }
  const [, mime, payload] = matched;
  if (!(ALLOWED_JD_IMAGE_MIME as readonly string[]).includes(mime)) {
    return { ok: false, reason: "type" };
  }
  if (!payload) {
    return { ok: false, reason: "empty" };
  }
  const bytes = estimateDataUrlBytes(dataUrl);
  if (bytes > MAX_JD_IMAGE_BYTES) {
    return { ok: false, reason: "size" };
  }
  return { ok: true, mime, bytes };
}

export type CapacityResult = { ok: true } | { ok: false; reason: "limit" | "total" };

/** 检查追加若干张图片后是否仍满足数量与总大小约束。 */
export function checkJdImageCapacity(
  existingBytes: number[],
  incomingBytes: number[]
): CapacityResult {
  if (existingBytes.length + incomingBytes.length > MAX_JD_IMAGES) {
    return { ok: false, reason: "limit" };
  }
  const total =
    existingBytes.reduce((sum, n) => sum + n, 0) +
    incomingBytes.reduce((sum, n) => sum + n, 0);
  if (total > MAX_JD_IMAGE_TOTAL_BYTES) {
    return { ok: false, reason: "total" };
  }
  return { ok: true };
}

/** 只接受 http/https 外链；拒绝 javascript:/data:/file: 等危险协议。 */
export function normalizeImageUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 外链图片统一走既有服务端代理，绕过防盗链与 CORS。 */
export function buildImageProxyUrl(url: string): string {
  return `/image-proxy?url=${encodeURIComponent(url)}`;
}

/**
 * 浏览器侧：把图片文件读成 data URL，必要时等比压缩以控制在单张上限内。
 * 刻意不复用 compressImage（它把图缩到 800px，会破坏 JD 截图的小字 OCR）。
 */
export async function imageFileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });

  if (estimateDataUrlBytes(raw) <= MAX_JD_IMAGE_BYTES) return raw;

  // 超限时等比缩到最长边 2000px（JD 截图文字仍可辨认），再以 JPEG 0.88 输出。
  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas-failed"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => reject(new Error("load-failed"));
    img.src = raw;
  });
}

/** 把经代理抓取到的 Blob 转成 data URL（用于「添加图片链接」入口）。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(blob);
  });
}
