// 临时验证脚本：真实应用工作台里检查 markdown 预览分页覆盖率 + 测量/显示副本一致性
import { chromium } from "playwright";
import fs from "fs";

const TOKEN = fs.readFileSync("/tmp/pagelab/token.txt", "utf8").trim();
const RESUME_ID = "36d4fc711860474db7a60a50d8aca383";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addInitScript((t) => {
  sessionStorage.setItem("jdmatch.auth.token", t);
}, TOKEN);
const page = await ctx.newPage();
const warnings = [];
page.on("console", (m) => {
  if (m.type() === "warning" || m.type() === "error") warnings.push(m.text().slice(0, 300));
});

await page.goto(`http://localhost:3005/app/workbench/${RESUME_ID}`, {
  waitUntil: "networkidle",
});
await page.waitForSelector(".md-page-sheet", { timeout: 60000 });
await page.waitForTimeout(2500);

const result = await page.evaluate(() => {
  const measure = document.querySelector('.resume-markdown-preview[aria-hidden]');
  const sheets = Array.from(document.querySelectorAll(".md-page-sheet"));
  const flows = sheets.map((s) => s.querySelector(".resume-markdown-preview"));

  const collect = (root) =>
    Array.from(root.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,section,table,hr"))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height > 0);

  const mRects = collect(measure);
  const sheetInfo = sheets.map((sheet, i) => {
    // 精确的裁切窗口：sheet > padding 层 > 窗口层
    const win = sheet.firstElementChild?.firstElementChild;
    const wr = win.getBoundingClientRect();
    const rects = collect(flows[i]);
    // 本页可见块索引：块与窗口相交（留 1px 容差）
    const visible = [];
    rects.forEach((r, idx) => {
      if (r.bottom > wr.top + 1 && r.top < wr.bottom - 1) visible.push(idx);
    });
    const first = visible.length ? flows[i].querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,section,table,hr")[visible[0]] : null;
    const last = visible.length ? flows[i].querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,section,table,hr")[visible[visible.length - 1]] : null;
    return {
      page: i + 1,
      winTop: +wr.top.toFixed(2),
      winH: +wr.height.toFixed(2),
      visibleCount: visible.length,
      firstIdx: visible[0] ?? null,
      lastIdx: visible[visible.length - 1] ?? null,
      firstText: (first?.textContent || "").slice(0, 24),
      lastText: (last?.textContent || "").slice(0, 24),
      visibleIdx: visible,
    };
  });

  // 覆盖率：所有块是否至少被某一页覆盖
  const covered = new Set();
  sheetInfo.forEach((s) => s.visibleIdx.forEach((i) => covered.add(i)));
  const missing = [];
  for (let i = 0; i < mRects.length; i++) if (!covered.has(i)) missing.push(i);
  // 重叠：同一块出现在两页（说明窗口比预想的大，或切点错乱）
  const seen = new Set();
  const dup = [];
  sheetInfo.forEach((s) => s.visibleIdx.forEach((i) => {
    if (seen.has(i)) dup.push(i);
    seen.add(i);
  }));
  // 越界：块只露出一部分（被窗口从中间切断）
  const partial = [];
  sheets.forEach((sheet, i) => {
    const wr = sheet.firstElementChild?.firstElementChild.getBoundingClientRect();
    const rects = collect(flows[i]);
    sheetInfo[i].visibleIdx.forEach((idx) => {
      const r = rects[idx];
      if (r.top < wr.top - 0.5 || r.bottom > wr.bottom + 0.5) partial.push({ page: i + 1, idx });
    });
  });

  // 测量副本 vs 第 1 页 / 第 2 页 的样式分歧
  const PROPS = ["display","position","box-sizing","width","margin-top","margin-bottom","padding-top","padding-bottom","padding-left","padding-right","font-family","font-size","font-weight","line-height","letter-spacing","text-indent","border-top-width","border-bottom-width","list-style-type","list-style-position"];
  const all = (r) => Array.from(r.querySelectorAll("*"));
  const diffStyles = (a, b, limit = 6) => {
    const ea = all(a), eb = all(b), out = [];
    if (ea.length !== eb.length) out.push({ prop: "elementCount", measure: String(ea.length), display: String(eb.length) });
    const n = Math.min(ea.length, eb.length);
    for (let i = 0; i < n && out.length < limit; i++) {
      const ca = getComputedStyle(ea[i]), cb = getComputedStyle(eb[i]);
      for (const p of PROPS) {
        const va = ca.getPropertyValue(p), vb = cb.getPropertyValue(p);
        if (va !== vb) { out.push({ idx: i, tag: ea[i].tagName, prop: p, measure: va, display: vb }); break; }
      }
    }
    return out;
  };

  const h3 = measure.querySelector("h3");
  const d3 = flows[0]?.querySelector("h3");
  const ulM = measure.querySelector("ul");
  const ulD = flows[0]?.querySelector("ul");

  return {
    sheetCount: sheets.length,
    blockCount: mRects.length,
    missing,
    dup,
    partial,
    sheets: sheetInfo,
    diffMeasureVsPage1: diffStyles(measure, flows[0]),
    diffPage1VsPage2: flows[1] ? diffStyles(flows[0], flows[1]) : [],
    headingFont: {
      measure: h3 ? getComputedStyle(h3).fontFamily : null,
      display: d3 ? getComputedStyle(d3).fontFamily : null,
    },
    ulStyle: {
      measure: ulM ? [getComputedStyle(ulM).margin, getComputedStyle(ulM).paddingLeft] : null,
      display: ulD ? [getComputedStyle(ulD).margin, getComputedStyle(ulD).paddingLeft] : null,
    },
  };
});

console.log(JSON.stringify(result, null, 1));
console.log("--- console warnings ---");
console.log(warnings.filter((w) => w.includes("MarkdownPreview")).join("\n") || "(无 MarkdownPreview 警告)");

await page.screenshot({ path: "/tmp/pagelab/final-full.png", fullPage: true });
const sheets = await page.$$(".md-page-sheet");
if (sheets[0]) await sheets[0].screenshot({ path: "/tmp/pagelab/final-p1.png" });
if (sheets[1]) await sheets[1].screenshot({ path: "/tmp/pagelab/final-p2.png" });

await browser.close();
