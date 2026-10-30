/**
 * 旧路径重定向契约（PLAN_guest_access P1）。
 *
 * /app/preview-template/$id → /templates/$id 必须透传查询参数（?locale=&snapshot=1）。
 * 背景缺陷（2026-10-30 审查 + buildLocation 实测）：redirect 不传 search 时
 * router-core 的 applyNext 会把目标 search 清空（`!dest.search → {}`），
 * 快照脚本/旧链接的 locale/snapshot 全部丢失。修复 = redirect 显式 `search: true`。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/routes/app/preview-template/$id.tsx", import.meta.url)),
  "utf-8"
);

describe("preview-template 重定向 search 透传", () => {
  it("redirect 显式携带 search: true（保留 ?locale=&snapshot=1）", () => {
    // 源码断言：防止回归时有人「简化」掉 search: true 又丢查询参数
    expect(source).toContain("search: true");
  });

  it("重定向目标为 /templates/$id", () => {
    expect(source).toContain('to: "/templates/$id"');
    expect(source).toContain("params: { id: params.id }");
  });
});
