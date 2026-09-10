/**
 * 品牌资产回归测试（2026-09-10 标识替换 V1.0）：
 *
 * 背景：旧标识存在两个相互独立的问题，且都不容易被肉眼发现 ——
 *   1. `public/logo.svg` 用 `@media (prefers-color-scheme: dark)` 判断明暗，
 *      但本项目主题由 next-themes 走 class（`html.light` / `html.dark`）。
 *      「系统深色 + 站点浅色」时标识会渲染成反色，几乎不可见；
 *   2. `Logo.tsx` 以正方形尺寸渲染 3:2 的源图，标识被压扁变形；
 *   3. `icon.png` / `favicon.ico` 与站内标识各改各的，长期不一致。
 *
 * 现在 `public/logo.svg` 是唯一几何源，四个形态文件共用同一份路径数据，
 * 图标由 `scripts/generate-brand-icons.mjs` 从它推导。本文件锁定这三条不变量。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

const publicFile = (name: string) =>
  fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const MARK_STEM_WIDTH = 14;

const VARIANTS = [
  { file: "logo.svg", label: "白底墨标", spine: "#0A0A0B", hook: "#5E6AD2", mono: false },
  { file: "logo-white.svg", label: "深底反白", spine: "#FFFFFF", hook: "#5E6AD2", mono: false },
  { file: "logo-mono.svg", label: "单色黑", spine: "#0A0A0B", hook: "#0A0A0B", mono: true },
  { file: "logo-mono-white.svg", label: "单色白", spine: "#FFFFFF", hook: "#FFFFFF", mono: true },
] as const;

function readSvg(file: string) {
  return readFileSync(publicFile(file), "utf8");
}

/** 抽出的单条路径：d 为几何数据，stroke 为显式色值。 */
interface MarkPath {
  d: string;
  stroke: string;
}

/**
 * 抽出 (d, stroke) 序列，顺序与 SVG 中一致：主脊 / 碗形 / 钩形。
 * 用 `Array.from(matchAll(...))` 而非展开运算符 —— 本项目 tsconfig 未设 target，
 * 展开可迭代对象需要 downlevelIteration，会引入类型错误。
 */
function readPaths(svg: string): MarkPath[] {
  return Array.from(
    svg.matchAll(/<path\s+d="([^"]+)"[^>]*?stroke="([^"]+)"/g),
    (m): MarkPath => ({ d: m[1], stroke: m[2] })
  );
}

describe("主标识几何", () => {
  it("四个形态各含 3 条路径（主脊 / D 碗形 / J 钩形）", () => {
    for (const variant of VARIANTS) {
      const paths = readPaths(readSvg(variant.file));
      expect(paths, variant.file).toHaveLength(3);
    }
  });

  it("四个形态共用同一份路径数据 —— 换背景色不会漏改几何", () => {
    const [reference, ...rest] = VARIANTS.map((v) => readPaths(readSvg(v.file)));
    const expected = reference.map((p) => p.d);

    rest.forEach((paths, index) => {
      expect(
        paths.map((p) => p.d),
        VARIANTS[index + 1].file
      ).toEqual(expected);
    });
  });

  it("笔画宽度统一为 14（同时是最小留白基准 x）", () => {
    for (const variant of VARIANTS) {
      const svg = readSvg(variant.file);
      const widths = Array.from(
        svg.matchAll(/stroke-width="(\d+)"/g),
        (m) => Number(m[1])
      );
      expect(widths, variant.file).toEqual([
        MARK_STEM_WIDTH,
        MARK_STEM_WIDTH,
        MARK_STEM_WIDTH,
      ]);
    }
  });

  it("J 钩形底部与 D 底边齐平（共用主脊的造型前提）", () => {
    // 主脊 y 16→84，钩形圆心 (33, 64) 半径 20 ⇒ 弧底 y=84
    const [spine, bowl, hook] = readPaths(readSvg("logo.svg"));
    expect(spine.d).toBe("M53 16V84");
    expect(bowl.d).toBe("M53 16A34 34 0 0 1 53 84");
    expect(hook.d).toContain("A20 20");
  });
});

describe("色彩契约", () => {
  it("各形态主脊 / 钩形用色符合规范", () => {
    for (const variant of VARIANTS) {
      const paths = readPaths(readSvg(variant.file));
      expect(paths.map((p) => p.stroke), variant.file).toEqual([
        variant.spine,
        variant.spine,
        variant.hook,
      ]);
    }
  });

  it("单色形态不含品牌强调色", () => {
    for (const variant of VARIANTS.filter((v) => v.mono)) {
      expect(readSvg(variant.file), variant.file).not.toContain("#5E6AD2");
    }
  });
});

describe("主题适配（回归 prefers-color-scheme 缺陷）", () => {
  it("静态标识不再依赖媒体查询自动翻色", () => {
    for (const variant of VARIANTS) {
      const svg = readSvg(variant.file);
      expect(svg, variant.file).not.toContain("prefers-color-scheme");
      expect(svg, variant.file).not.toContain("<style");
    }
  });

  it("明暗交替由成对文件承担，颜色为显式字面量", () => {
    expect(readSvg("logo.svg")).toContain("#0A0A0B");
    expect(readSvg("logo.svg")).not.toContain("#FFFFFF");
    expect(readSvg("logo-white.svg")).toContain("#FFFFFF");
  });
});

describe("应用图标与 favicon", () => {
  it("icon.png 为 512×512", async () => {
    const meta = await sharp(publicFile("icon.png")).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it("favicon.ico 为合法 ICO 容器，含 16 / 32 / 48 三档", () => {
    const ico = readFileSync(publicFile("favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type = icon
    const count = ico.readUInt16LE(4);
    expect(count).toBe(3);

    const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16));
    expect(sizes).toEqual([16, 32, 48]);

    // 每档载荷都是 PNG（ICO 允许内嵌 PNG），且偏移落在文件内
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + length, `entry ${i}`).toBeLessThanOrEqual(ico.length);
      expect(ico.subarray(offset, offset + 8).toString("hex"), `entry ${i}`).toBe(
        "89504e470d0a1a0a"
      );
    }
  });
});
