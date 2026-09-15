import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 编辑态标题垂直节奏回归测试（2026-09-11 修复）。
 *
 * 历史 bug —— src/styles/tiptap.scss 的标题间距直接照搬 Tiptap 官方示例样式
 * （h1/h2 margin-top 3.5rem ≈ 56px，h3–h6 2.5rem ≈ 40px，h1/h2 margin-bottom
 * 1.5rem ≈ 24px）。这是「长文正文」的排版尺度，而简历是单页密排文档：
 *   1. 编辑区一屏放不下几个模块，滚动成本高；
 *   2. 右侧产出态（.resume-markdown-preview）h2 上间距默认只有
 *      moduleSpacing = 12px（见 MarkdownPreview.tsx / markdownVariants.ts），
 *      编辑态与产出态的疏密相差近 5 倍，所见非所得。
 *
 * 现改为 4px 栅格上的紧凑节奏（与 Tailwind 默认 spacing scale 同源），
 * 并遵循邻近性原则：标题「上间距 : 下间距」≈ 3 : 1。本文件钉住该节奏，
 * 防止有人再从 Tiptap 示例样式里把长文尺度抄回来。
 *
 * 注意：本测试只覆盖编辑态（.tiptap）。产出态标题样式由版式变体
 * （markdownVariants.ts）与 MarkdownPreview.tsx 的行内样式决定，两者互不影响
 * —— 导出/打印 HTML 的内容根节点是 .resume-markdown-preview，从不带 .tiptap。
 */

const scssPath = fileURLToPath(
  new URL("../src/styles/tiptap.scss", import.meta.url)
);
const scss = readFileSync(scssPath, "utf8");

/** 剥离 CSS 注释：注释里会引用历史值说明修复原因，不参与断言 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 截取「标题垂直节奏」段（至 code 规则为止），并解析出其中的规则块 */
const sectionRaw = (() => {
  const marker = scss.indexOf("标题垂直节奏");
  const start = scss.lastIndexOf("/*", marker);
  const end = scss.indexOf("\n  code {", marker);
  return scss.slice(start, end);
})();
const sectionCss = stripComments(sectionRaw);

interface Rule {
  selector: string;
  body: string;
}

/** 逐字符配对花括号的极简规则切分，避免嵌套块被截断 */
const parseRules = (css: string): Rule[] => {
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) break;
    const selector = css.slice(cursor, open).trim().replace(/\s+/g, " ");
    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") depth += 1;
      else if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (selector) {
      rules.push({ selector, body: css.slice(open + 1, close) });
    }
    cursor = close + 1;
  }
  return rules;
};

const rules = parseRules(sectionCss);

const readDecl = (body: string, prop: string): string | undefined => {
  const matched = body.match(
    new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i")
  );
  return matched?.[1].trim();
};

/** 取某选择器（多个选择器并列时按第一个命中）的声明体 */
const bodyOf = (...selectors: string[]): string => {
  const found = rules.find((rule) => selectors.includes(rule.selector));
  if (!found) {
    throw new Error(`未找到规则：${selectors.join(" | ")}`);
  }
  return found.body;
};

const px = (value: string): number => {
  const matched = value.match(/^(-?[\d.]+)(rem|px|em)$/);
  if (!matched) throw new Error(`无法解析长度：${value}`);
  const [, num, unit] = matched;
  return unit === "px" ? Number(num) : Number(num) * 16;
};

const BASE_SELECTOR = "h1, h2, h3, h4, h5, h6";
const baseBody = bodyOf(BASE_SELECTOR);

/** 合并「通用标题规则 + 该层级专属规则」，得到某层级的实际生效值 */
const effective = (level: number) => {
  const ownBody = (() => {
    if (level <= 3) {
      const own = rules.find((rule) => rule.selector === `h${level}`);
      return own?.body ?? "";
    }
    const grouped = rules.find((rule) => rule.selector === "h4, h5, h6");
    if (!grouped) throw new Error("未找到 h4, h5, h6 规则");
    return grouped.body;
  })();

  const resolve = (prop: string) =>
    readDecl(ownBody, prop) ?? readDecl(baseBody, prop);

  return {
    marginTop: px(resolve("margin-top") as string),
    marginBottom: px(resolve("margin-bottom") as string),
    lineHeight: Number(resolve("line-height")),
    fontSize: px(resolve("font-size") as string),
  };
};

describe("编辑态标题间距落在紧凑节奏区间（不再照搬长文尺度）", () => {
  it("不再出现 Tiptap 示例样式的超量间距值", () => {
    expect(sectionCss).not.toMatch(/margin-top:\s*(2\.5rem|3\.5rem)/);
    expect(sectionCss).not.toMatch(/margin-bottom:\s*1\.5rem/);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "h%i 上间距 12–28px、下间距 2–8px，且上 : 下 ≥ 2.5 : 1",
    (level) => {
      const { marginTop, marginBottom } = effective(level);
      expect(marginTop).toBeGreaterThanOrEqual(12);
      expect(marginTop).toBeLessThanOrEqual(28);
      expect(marginBottom).toBeGreaterThanOrEqual(2);
      expect(marginBottom).toBeLessThanOrEqual(8);
      // 邻近性原则：标题必须比「离上一块」更靠近「离下一块」
      expect(marginTop / marginBottom).toBeGreaterThanOrEqual(2.5);
    }
  );

  it("层级越高留白越大：h1 > h2 > h3 > h4 = h5 = h6", () => {
    const tops = [1, 2, 3, 4, 5, 6].map((level) => effective(level).marginTop);
    expect(tops[0]).toBeGreaterThan(tops[1]);
    expect(tops[1]).toBeGreaterThan(tops[2]);
    expect(tops[2]).toBeGreaterThan(tops[3]);
    expect(tops[3]).toBe(tops[4]);
    expect(tops[4]).toBe(tops[5]);
  });

  it("行高不小于 1.2（1.1 会让换行标题行距小于字号本身）", () => {
    [1, 2, 3, 4].forEach((level) => {
      expect(effective(level).lineHeight).toBeGreaterThanOrEqual(1.2);
    });
  });

  it("首块 / 末块外间距归零，避免编辑区上下凭空多出空白", () => {
    expect(bodyOf("> :first-child")).toMatch(/margin-top:\s*0/);
    expect(bodyOf("> :last-child")).toMatch(/margin-bottom:\s*0/);
  });
});

describe("字号比例与产出态保持一致（间距修复不得顺手改字号）", () => {
  it.each([
    [1, 22.4],
    [2, 19.2],
    [3, 17.6],
    [4, 16],
    [5, 16],
    [6, 16],
  ])("h%i 为 %ipx（编辑器 14px 正文下的产出态等价比例）", (level, expected) => {
    expect(effective(level).fontSize).toBeCloseTo(expected, 1);
  });
});

describe("作用域约束", () => {
  it("标题规则全部位于 .tiptap 作用域内，不得出现顶层裸 h1/h2 选择器", () => {
    // 顶层规则应为 .tiptap / .resume-preview / .control-group / [contenteditable]
    expect(stripComments(scss)).not.toMatch(/^(h[1-6])\b/m);
  });

  it("产出态（.resume-preview / .resume-markdown-preview）标题不得在此文件声明间距", () => {
    // 产出态标题间距由版式变体（markdownVariants.ts）与 MarkdownPreview.tsx 决定。
    // 本文件若对产出态标题也写间距，会与变体规则互相打架（且分页测量副本与显示
    // 副本必须排版一致）。此处钉住「编辑态与产出态互不越界」。
    const previewHeadingRules = parseRules(stripComments(scss)).filter(
      (rule) =>
        /h[1-6]/.test(rule.selector) &&
        /resume-(markdown-)?preview/.test(rule.selector)
    );
    previewHeadingRules.forEach((rule) => {
      expect(rule.body).not.toMatch(/margin-(top|bottom)/);
    });
  });
});
