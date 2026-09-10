#!/usr/bin/env node
// 由品牌主标识生成应用图标与站点 favicon。
//
// 背景：public/icon.png（PWA / apple-touch-icon）与 public/favicon.ico 长期停留在旧标，
// 与 public/logo.svg 不再一致 —— 每次换标都要人工「三处同步」，属于典型的重复劳动。
// 本脚本把「主标识 → 图标」的推导固化为可重跑的流程，单一数据源就是 public/logo.svg。
//
// 产出（全部落在 public/，随构建发布）：
//   icon.png     512×512 应用图标（墨黑圆角底板 + 反白标识 + 靛蓝钩形）
//   favicon.ico  16 / 32 / 48 三尺寸，内含 PNG 载荷（现代浏览器均支持）
//
// 用法：node scripts/generate-brand-icons.mjs
// public/logo.svg 变更后重新执行即可。
//
// 造型规则见 docs/BRAND.md：底板圆角取边长的 22%，标识墨迹四周留白约 15.6%。

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(scriptDir, "..", "public");
const MARK_SOURCE = resolve(publicDir, "logo.svg");

/** 构造网格尺寸，与 public/logo.svg 的 viewBox 一致。 */
const GRID = 100;
/**
 * 底板内标识的缩放倍数。上限由「最小留白 = x」推导：
 * 留白 = 256 − 0.44·S ≥ 0.14·S  ⇒  S ≤ 441，取 430 留出余量。
 */
const MARK_SCALE = 4.3;
const TILE_SIZE = 512;
/** 底板圆角 = 边长的 22%（品牌规范「图标版」）。 */
const TILE_RADIUS = Math.round(TILE_SIZE * 0.22);
const FAVICON_SIZES = [16, 32, 48];

const COLORS = {
  tile: "#0A0A0B",
  ink: "#FFFFFF",
  accent: "#5E6AD2",
};

if (!existsSync(MARK_SOURCE)) {
  console.error(`[brand] 源标识缺失：${MARK_SOURCE}`);
  process.exit(1);
}

/** 从 logo.svg 抽出三条路径的 d 属性，保证图标与站内标识共用同一份几何。 */
function readMarkPaths() {
  const svg = readFileSync(MARK_SOURCE, "utf8");
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 3) {
    throw new Error(
      `[brand] 预期在 logo.svg 中找到 3 条路径（主脊 / 碗形 / 钩形），实际 ${paths.length} 条`
    );
  }
  return paths;
}

/** 组装应用图标 SVG：墨黑圆角底板 + 反白标识 + 靛蓝钩形。 */
function buildTileSvg([spine, bowl, hook]) {
  const offset = TILE_SIZE / 2 - (GRID / 2) * MARK_SCALE;
  const stroke = (color) =>
    `stroke="${color}" stroke-width="14" stroke-linecap="round"`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}" fill="none">
  <rect width="${TILE_SIZE}" height="${TILE_SIZE}" rx="${TILE_RADIUS}" fill="${COLORS.tile}"/>
  <g transform="translate(${offset} ${offset}) scale(${MARK_SCALE})">
    <path d="${spine}" ${stroke(COLORS.ink)}/>
    <path d="${bowl}" ${stroke(COLORS.ink)}/>
    <path d="${hook}" ${stroke(COLORS.accent)}/>
  </g>
</svg>`;
}

/** 把若干尺寸的 PNG 打包成 ICO（ICONDIR + ICONDIRENTRY[] + PNG 载荷）。 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((image) => {
    const entry = Buffer.alloc(16);
    // 256 及以上在 ICO 目录中以 0 表示
    const dimension = image.size >= 256 ? 0 : image.size;
    entry.writeUInt8(dimension, 0); // width
    entry.writeUInt8(dimension, 1); // height
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.buffer.length;
    return entry;
  });

  return Buffer.concat([
    header,
    ...entries,
    ...images.map((image) => image.buffer),
  ]);
}

const markPaths = readMarkPaths();
const tileSvg = buildTileSvg(markPaths);
// sharp 实例是单向消费的，每次输出都从同一份 SVG 重新构造，避免 clone 带来的状态耦合
const renderTile = (size) =>
  sharp(Buffer.from(tileSvg)).resize(size, size).png({ compressionLevel: 9 });

const iconPath = resolve(publicDir, "icon.png");
await renderTile(TILE_SIZE).toFile(iconPath);
console.log(
  `[brand] icon.png ${TILE_SIZE}×${TILE_SIZE} (${Math.round(
    statSync(iconPath).size / 1024
  )}KB)`
);

const faviconImages = await Promise.all(
  FAVICON_SIZES.map(async (size) => ({
    size,
    buffer: await renderTile(size).toBuffer(),
  }))
);

const faviconPath = resolve(publicDir, "favicon.ico");
writeFileSync(faviconPath, buildIco(faviconImages));
console.log(
  `[brand] favicon.ico ${FAVICON_SIZES.join("/")} (${Math.round(
    statSync(faviconPath).size / 1024
  )}KB)`
);

console.log("[brand] 品牌图标生成完成");
