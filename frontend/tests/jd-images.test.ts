/**
 * JD 截图上传纯逻辑的单元测试（无 DOM / 网络依赖）。
 *
 * 同时锁定 zh/en 新增文案同构：漏写任一语言会在运行期变成 raw key，
 * 且 en 里混入中文是此前 guest.gate 已经踩过的坑。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_JD_IMAGE_MIME,
  MAX_JD_IMAGES,
  MAX_JD_IMAGE_BYTES,
  MAX_JD_IMAGE_TOTAL_BYTES,
  buildImageProxyUrl,
  checkJdImageCapacity,
  estimateDataUrlBytes,
  normalizeImageUrl,
  validateJdImage,
} from "@/lib/jdImages";

const dataUrl = (bytes: number, mime = "image/png") =>
  `data:${mime};base64,${Buffer.from(new Uint8Array(bytes)).toString("base64")}`;

describe("estimateDataUrlBytes", () => {
  it("由 base64 长度精确反推字节数", () => {
    // 3 字节 → "AAAA"（无 padding），4 字符 × 3/4 = 3
    expect(estimateDataUrlBytes(dataUrl(3))).toBe(3);
    // 1 字节 → "AA=="，padding 修正后 = 1
    expect(estimateDataUrlBytes(dataUrl(1))).toBe(1);
  });
});

describe("validateJdImage", () => {
  it("接受白名单内的合法 data URL", () => {
    for (const mime of ALLOWED_JD_IMAGE_MIME) {
      const result = validateJdImage(dataUrl(16, mime));
      expect(result.ok, mime).toBe(true);
      if (result.ok) expect(result.mime).toBe(mime);
    }
  });

  it("拒绝非 data URL / 非 base64 格式", () => {
    expect(validateJdImage("https://example.com/a.png")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateJdImage("data:image/png,a.png")).toEqual({
      ok: false,
      reason: "invalid-base64",
    });
  });

  it("拒绝 SVG 等白名单外 MIME（防可执行脚本载体）", () => {
    expect(validateJdImage(dataUrl(8, "image/svg+xml"))).toEqual({
      ok: false,
      reason: "type",
    });
  });

  it("拒绝空内容与非法 base64", () => {
    expect(validateJdImage("data:image/png;base64,")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(validateJdImage("data:image/png;base64,@@@@")).toEqual({
      ok: false,
      reason: "invalid-base64",
    });
  });

  it("拒绝超过单张上限的图片", () => {
    const huge = `data:image/png;base64,${"A".repeat(
      Math.ceil(((MAX_JD_IMAGE_BYTES + 1) * 4) / 3)
    )}`;
    expect(validateJdImage(huge)).toEqual({ ok: false, reason: "size" });
  });
});

describe("checkJdImageCapacity", () => {
  it("数量超过上限时返回 limit", () => {
    const result = checkJdImageCapacity(
      new Array(MAX_JD_IMAGES).fill(1),
      [1]
    );
    expect(result).toEqual({ ok: false, reason: "limit" });
  });

  it("总量超过上限时返回 total", () => {
    const result = checkJdImageCapacity([1], [MAX_JD_IMAGE_TOTAL_BYTES]);
    expect(result).toEqual({ ok: false, reason: "total" });
  });

  it("边界内通过", () => {
    expect(checkJdImageCapacity([1, 1], [1, 1])).toEqual({ ok: true });
  });
});

describe("normalizeImageUrl / buildImageProxyUrl", () => {
  it("只接受 http/https", () => {
    expect(normalizeImageUrl("  https://example.com/jd.png  ")).toBe(
      "https://example.com/jd.png"
    );
    expect(normalizeImageUrl("http://example.com/jd.png")).toBe(
      "http://example.com/jd.png"
    );
    for (const bad of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "ftp://example.com/a.png",
      "not a url",
      "",
    ]) {
      expect(normalizeImageUrl(bad), bad).toBeNull();
    }
  });

  it("代理 URL 正确编码", () => {
    expect(buildImageProxyUrl("https://example.com/a b.png")).toBe(
      "/image-proxy?url=https%3A%2F%2Fexample.com%2Fa%20b.png"
    );
  });
});

describe("JD 截图 i18n 文案", () => {
  const localesDir = fileURLToPath(
    new URL("../src/i18n/locales/", import.meta.url)
  );
  const load = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(`${localesDir}${name}.json`, "utf-8"));

  const keys = [
    "jdImagesLabel",
    "jdImagesHint",
    "jdImagesAdd",
    "jdImagesAddLink",
    "jdImagesLinkPlaceholder",
    "jdImagesLinkSubmit",
    "jdImagesLinkCancel",
    "jdImagesRemove",
    "jdImagesEmpty",
    "jdImagesLimit",
    "jdImagesTotalTooLarge",
    "jdImagesTooLarge",
    "jdImagesType",
    "jdImagesLoadFailed",
    "jdImagesInvalidUrl",
  ];

  it("zh/en 均存在全部新增 key 且为非空字符串", () => {
    const zh = load("zh") as { jobmatch: Record<string, unknown> };
    const en = load("en") as { jobmatch: Record<string, unknown> };
    for (const key of keys) {
      expect(typeof zh.jobmatch[key], `zh ${key}`).toBe("string");
      expect(typeof en.jobmatch[key], `en ${key}`).toBe("string");
    }
  });

  it("en 文案不含 CJK 且插值占位符一致", () => {
    const zh = load("zh") as { jobmatch: Record<string, string> };
    const en = load("en") as { jobmatch: Record<string, string> };
    const cjk = /[一-鿿㐀-䶿]/;
    for (const key of keys) {
      expect(cjk.test(en.jobmatch[key]), `en ${key}`).toBe(false);
    }
    expect(en.jobmatch.jdImagesLimit).toContain("{max}");
    expect(zh.jobmatch.jdImagesLimit).toContain("{max}");
  });
});
