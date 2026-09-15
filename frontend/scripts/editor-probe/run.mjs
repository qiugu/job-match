/**
 * 编辑器 Markdown 往返探针（一站式运行）。
 *
 * 用途：验证「markdown → Tiptap 文档 → markdown」的往返保真度。
 * 为什么需要它：编辑器的解析/序列化链路（tiptap-markdown + 自定义 Align 扩展）
 * 只靠读代码很难判断某段 markdown 在编辑器里会变成什么 —— 需要真实 DOM 与
 * 真实 schema。本项目测试环境是 node（无 jsdom），所以用 Vite 打包一个最小页面、
 * 交给 Playwright 在真实 Chromium 里跑。
 *
 * 用法：
 *   node scripts/editor-probe/run.mjs                 # 打印各用例的 before / after JSON
 *   node scripts/editor-probe/run.mjs --shot out.png  # 截图真实编辑区（用于修复前后对比）
 *
 * 输出：main.js 里 window.__probe() 的 JSON（各用例的 before / after）。
 * 新增用例：编辑 scripts/editor-probe/main.js 的 __probe()。
 *
 * 注意：Tiptap 的 create 事件是异步触发的，扩展的 onCreate（Align 的序列化器
 * 补丁就在这里）不会在 new Editor() 返回时完成 —— 必须 await 一个 tick 再断言，
 * 否则会得到「补丁没装上」的假阴性（本探针第一版即踩此坑）。
 */
import { build } from "vite";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(here, "dist");

// 1) 打包探针页面
await build({
  configFile: join(here, "vite.config.mjs"),
  logLevel: "error",
});

// 2) 起一个最小的静态服务（file:// 下 ESM 会被 CORS 拦）
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};
const server = createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const filePath = join(outDir, urlPath === "/" ? "index.html" : urlPath);
  if (!existsSync(filePath)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// 3) 真浏览器里跑断言 / 截图
const shotIndex = process.argv.indexOf("--shot");
const shotPath = shotIndex === -1 ? null : process.argv[shotIndex + 1];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 400)));

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });

  if (shotPath) {
    await page.evaluate("window.__mountVisual()");
    // 等字体与布局稳定，否则两次截图会因字体加载时机不同而错位
    await page.evaluate("document.fonts.ready");
    await page.locator("#visual-root").screenshot({ path: shotPath });
    console.log(`截图已保存：${shotPath}`);
  } else {
    const result = await page.evaluate("window.__probe()");
    console.log(JSON.stringify(result, null, 2));
  }

  if (errors.length) {
    console.error("\n页面错误：");
    errors.forEach((error) => console.error(" -", error));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
