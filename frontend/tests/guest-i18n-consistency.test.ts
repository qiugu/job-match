/**
 * i18n 一致性契约测试（游客门控文案回归）。
 *
 * 背景缺陷（2026-10-30 审查）：en.json 的 guest.gate.*.title 曾残留中文，
 * 且 gate.*.description 在 en 是数组、zh 是字符串——compat 层对非字符串值
 * 走 String(value)，数组被渲染成逗号连接的断裂长句。
 *
 * 本测试锁定：
 * 1. en 的 guest.gate.*.title / description 不得含 CJK 字符；
 * 2. zh/en 的 gate 子树同构（key 集合一致、对应值类型一致）；
 * 3. description 两侧均为字符串（禁止数组等异构类型）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const localesDir = fileURLToPath(
  new URL("../src/i18n/locales/", import.meta.url)
);

function loadLocale(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${localesDir}${name}.json`, "utf-8"));
}

/** CJK 统一表意文字（含扩展 A）——英文语言包文案不应出现 */
const CJK_RE = /[一-鿿㐀-䶿]/;

type JsonNode = string | number | boolean | null | JsonNode[] | { [k: string]: JsonNode };

function collectPaths(
  node: JsonNode,
  prefix = ""
): Map<string, string | number | boolean | null | "array" | "object"> {
  const out = new Map<string, string | number | boolean | null | "array" | "object">();
  if (Array.isArray(node)) {
    out.set(prefix, "array");
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [p, v] of collectPaths(value, path)) out.set(p, v);
    }
    return out;
  }
  out.set(prefix, node);
  return out;
}

describe("guest.gate i18n 一致性（en 文案回归）", () => {
  const zh = loadLocale("zh");
  const en = loadLocale("en");
  const zhGate = (zh as { guest?: { gate?: JsonNode } }).guest?.gate;
  const enGate = (en as { guest?: { gate?: JsonNode } }).guest?.gate;

  it("zh/en 均存在 guest.gate 子树", () => {
    expect(zhGate).toBeTruthy();
    expect(enGate).toBeTruthy();
  });

  it("en 的 gate 文案不含中文（title/description 回归）", () => {
    const paths = collectPaths(enGate!);
    for (const [path, value] of paths) {
      if (typeof value === "string") {
        expect(
          CJK_RE.test(value),
          `en guest.gate.${path} 不应含 CJK：${value}`
        ).toBe(false);
      }
    }
  });

  it("gate.*.description 两侧均为字符串（禁数组异构）", () => {
    for (const feature of ["pdf", "grammar", "polish", "translate"]) {
      const zhDesc = (zhGate as Record<string, Record<string, unknown>>)[feature]?.description;
      const enDesc = (enGate as Record<string, Record<string, unknown>>)[feature]?.description;
      expect(typeof zhDesc, `zh gate.${feature}.description 应为 string`).toBe("string");
      expect(typeof enDesc, `en gate.${feature}.description 应为 string`).toBe("string");
    }
  });

  it("zh/en gate 子树同构：key 集合与值类型一致", () => {
    const zhPaths = collectPaths(zhGate!);
    const enPaths = collectPaths(enGate!);

    expect([...enPaths.keys()].sort()).toEqual([...zhPaths.keys()].sort());

    for (const [path, zhValue] of zhPaths) {
      const enValue = enPaths.get(path);
      const zhType = zhValue === null ? "null" : typeof zhValue === "object" ? "object" : typeof zhValue;
      const enType = enValue === null ? "null" : typeof enValue === "object" ? "object" : typeof enValue;
      // 数组/对象在 collectPaths 里被折叠为 "array"/"object" 标记
      expect(
        `${path}:${enType}`,
        `en guest.gate.${path} 类型应与 zh 一致`
      ).toBe(`${path}:${zhType}`);
    }
  });
});
