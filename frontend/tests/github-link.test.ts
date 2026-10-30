/**
 * 站内 GitHub 链接回归测试（2026-10-30）：
 *
 * 背景：移动端菜单的「Star on GitHub」按钮把链接硬编码成上游 fork 来源仓库
 * `JOYCEQL/magic-resume`，访客点击后被引到别人的仓库（1.1 万 star）；
 * 桌面端顶栏没有该按钮，所以问题只在移动端暴露。
 * 修复：链接与星标 API 统一由 `config/constants.ts` 的 `GITHUB_REPO_SLUG` 派生。
 *
 * 本文件锁定三条不变量：
 *   1. 仓库 slug = 自有仓库 `qiugu/job-match`；
 *   2. 组件只引用常量，不自己硬编码 github.com 链接；
 *   3. `src/` 下不再残留任何指向上游仓库的链接。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

/** 递归收集 src 下的所有文件（跳过二进制资源，避免读出乱码） */
function collectSrcFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectSrcFiles(full);
    return /\.(ts|tsx|js|jsx|css|html|json)$/.test(entry) ? [full] : [];
  });
}

describe("站内 GitHub 链接", () => {
  it("仓库 slug 指向自有仓库 qiugu/job-match", () => {
    const constants = source("src/config/constants.ts");

    expect(constants).toContain('GITHUB_REPO_SLUG = "qiugu/job-match"');
    expect(constants).toContain(
      "export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_SLUG}`"
    );
    expect(constants).toContain(
      "export const GITHUB_API_REPO_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}`"
    );
  });

  it("Star 按钮引用常量，不硬编码链接", () => {
    const stars = source("src/components/shared/GitHubStars.tsx");

    expect(stars).toContain('from "@/config/constants"');
    expect(stars).toContain("href={GITHUB_REPO_URL}");
    expect(stars).toContain("fetch(GITHUB_API_REPO_URL)");
    // 组件内不得出现任何字面量 github.com 链接（防止再次漂移）
    expect(stars).not.toContain("github.com/");
  });

  it("src 下不再残留指向上游仓库的链接", () => {
    // 只判「真实链接」，不判注释里的历史说明文字（constants.ts 保留了
    // 这段背景注释用于后人溯源，slug 文本本身不是跳转目标）。
    const upstreamLink = /(?:github\.com|api\.github\.com\/repos)\/JOYCEQL/i;
    const offenders: string[] = [];

    for (const file of collectSrcFiles(resolve(process.cwd(), "src"))) {
      if (upstreamLink.test(readFileSync(file, "utf8"))) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
    // 全树 I/O 扫描在外置卷上约 10s，超过 vitest 默认 5s，此处显式放宽
  }, 30000);

  it("移动端菜单仍挂载 GitHub 入口（仅链接目标被修正）", () => {
    const mobileMenu = source("src/components/home/client/MobileMenu.tsx");

    expect(mobileMenu).toContain("<GitHubStars />");
  });
});
