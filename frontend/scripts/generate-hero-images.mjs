#!/usr/bin/env node
// 生成落地页首屏图的多尺寸 / 多格式版本，以及社交分享用的 OG 图。
//
// 背景：public/web-shot.jpg 是单张 2560×1440 / 328KB 的截图，首屏 LCP 图片无论
// 在手机还是桌面都下载同一份，浪费约 60–70% 字节；og:image 此前指向不存在的
// /web-shot.png，社交卡片全 404。本脚本一次性产出两者：
//   web-shot-{1200,1920}.webp / .avif —— Hero <picture> 的响应式源
//   og-image.png                      —— 1200×630 的 OG / Twitter 卡片图
//
// 用法：node scripts/generate-hero-images.mjs
// 源文件变更后重新执行即可；产物直接进 public/ 随构建发布。

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "..", "public");
const SOURCE = resolve(publicDir, "web-shot.jpg");

const HERO_WIDTHS = [1200, 1920];
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

if (!existsSync(SOURCE)) {
  console.error(`[seo] 源文件缺失：${SOURCE}`);
  process.exit(1);
}

async function generateHeroVariants() {
  for (const width of HERO_WIDTHS) {
    const base = resolve(publicDir, `web-shot-${width}`);

    await sharp(SOURCE)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(`${base}.webp`);

    await sharp(SOURCE)
      .resize({ width, withoutEnlargement: true })
      .avif({ quality: 50 })
      .toFile(`${base}.avif`);

    console.log(`[seo] hero ${width}: webp + avif`);
  }
}

async function generateOgImage() {
  const output = resolve(publicDir, "og-image.png");

  await sharp(SOURCE)
    // OG 推荐 1200×630（1.91:1）。源图是 16:9，cover + top 对齐可保留截图顶部
    // 的编辑器标题栏，避免出现半截 UI。
    .resize(OG_WIDTH, OG_HEIGHT, { fit: "cover", position: "top" })
    .png({ quality: 90, compressionLevel: 9 })
    .toFile(output);

  const { size } = statSync(output);
  const meta = await sharp(output).metadata();
  console.log(
    `[seo] og-image.png ${meta.width}×${meta.height} (${Math.round(
      size / 1024
    )}KB)`
  );
}

await generateHeroVariants();
await generateOgImage();
console.log("[seo] 图片生成完成");
