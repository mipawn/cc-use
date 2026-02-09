#!/usr/bin/env node

/**
 * Icon generation script for CC Use
 *
 * Tray icons (macOS / Windows / Linux use the same visual style):
 *   Mostly-white rounded-rect background with the original icon area cut out
 *   to transparency ("white plate + transparent glyph").
 *
 * Output:
 *   - tray.png       (22x22)   macOS/Linux tray base
 *   - tray@2x.png    (44x44)   macOS Retina representation
 *   - tray.ico                  Windows tray (16/20/24/32)
 *   - icon.ico                  Windows app icon (from dock.png)
 *
 * Usage: node scripts/generate-icons.mjs
 */

import sharp from "sharp";
import pngToIco from "png-to-ico";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const buildDir = path.join(__dirname, "..", "build");

// Tray tuning
// - Plate color: slightly off-white to avoid harsh white
// - Padding ratios: keep modest so the image stays compact (smaller click area)
const PLATE_COLOR = "#f3f4f6";
const PLATE_PADDING_RATIO = 0.12;
const GLYPH_PADDING_RATIO = 0.18;

const CORNER_RADIUS_RATIO = 0.22;

// --- Helpers ---

function roundedRectSvg(size, color, radiusRatio) {
  const r = Math.round(size * radiusRatio);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${color}"/>
    </svg>`,
  );
}

function circleSvg(size, color, padding) {
  const cx = size / 2;
  const cy = size / 2;
  const r = Math.max(1, (size - padding * 2) / 2);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>
    </svg>`,
  );
}

/**
 * Tray icon: white rounded-rect background with icon alpha punched out.
 *
 * Implementation detail:
 * - Background is solid white (RGBA 255,255,255,255)
 * - Icon is resized into padded inner area
 * - For each pixel: bgAlpha = 255 - iconAlpha (so icon becomes transparent)
 *   This preserves anti-aliased edges.
 */
async function trayCutoutWhite(sourceBuffer, size) {
  const platePadding = Math.max(Math.round(size * PLATE_PADDING_RATIO), 1);
  const glyphPadding = Math.max(Math.round(size * GLYPH_PADDING_RATIO), 1);

  // Background: only a circular white content area, outer area stays transparent
  const { data: bg, info: bgInfo } = await sharp(
    circleSvg(size, PLATE_COLOR, platePadding),
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const inner = size - glyphPadding * 2;

  const { data: icon, info: iconInfo } = await sharp(sourceBuffer)
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (bgInfo.width !== size || bgInfo.height !== size) {
    throw new Error("Unexpected background size");
  }
  if (iconInfo.width !== inner || iconInfo.height !== inner) {
    throw new Error("Unexpected icon size");
  }

  // Punch out alpha in the icon region
  for (let iy = 0; iy < inner; iy++) {
    for (let ix = 0; ix < inner; ix++) {
      const bgX = ix + glyphPadding;
      const bgY = iy + glyphPadding;
      const bgIdx = (bgY * size + bgX) * 4;
      const iconIdx = (iy * inner + ix) * 4;

      const iconAlpha = icon[iconIdx + 3];
      if (iconAlpha === 0) continue;

      // Keep plate RGB as-is, adjust alpha only
      bg[bgIdx + 3] = Math.max(0, 255 - iconAlpha);
    }
  }

  return sharp(bg, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

function writeTempPng(buffer, label) {
  const p = path.join(buildDir, `_tmp_${label}.png`);
  fs.writeFileSync(p, buffer);
  return p;
}

// --- Main ---

async function main() {
  const iconSrcPath = path.join(buildDir, "icon.png");
  const dockSrcPath = path.join(buildDir, "dock.png");

  if (!fs.existsSync(iconSrcPath)) {
    console.error("Error: build/icon.png not found.");
    process.exit(1);
  }

  const iconSrc = fs.readFileSync(iconSrcPath);
  const hasDock = fs.existsSync(dockSrcPath);
  const dockSrc = hasDock ? fs.readFileSync(dockSrcPath) : null;
  console.log("Source icons loaded\n");

  const tempFiles = [];

  // ── 1. Tray icons (white plate + transparent cutout) ─────
  console.log("Tray icons (white plate + transparent cutout):");

  // macOS/Linux tray base + Retina
  // macOS menu bar items size is derived from the image width; keep it small.
  const tray22 = await trayCutoutWhite(iconSrc, 22);
  fs.writeFileSync(path.join(buildDir, "tray.png"), tray22);
  console.log("  tray.png (22x22)");

  const tray44 = await trayCutoutWhite(iconSrc, 44);
  fs.writeFileSync(path.join(buildDir, "tray@2x.png"), tray44);
  console.log("  tray@2x.png (44x44)");

  // Windows tray: tray.ico (16/20/24/32)
  const trayTempFiles = [];
  for (const s of [16, 20, 24, 32]) {
    const buf = await trayCutoutWhite(iconSrc, s);
    trayTempFiles.push(writeTempPng(buf, `tray_${s}`));
    console.log(`  tray ${s}x${s}`);
  }
  const trayIcoBuffer = await pngToIco(trayTempFiles);
  fs.writeFileSync(path.join(buildDir, "tray.ico"), trayIcoBuffer);
  console.log("  -> build/tray.ico\n");

  // ── 2. Windows app icon (icon.ico) ────────────────────────
  //    From dock.png so Windows shortcuts match macOS dock icon.
  console.log("Windows app icon (icon.ico):");
  const appSizes = [16, 24, 32, 48, 64, 128, 256];

  if (dockSrc) {
    for (const s of appSizes) {
      const buf = await sharp(dockSrc)
        .resize(s, s, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      tempFiles.push(writeTempPng(buf, `app_${s}`));
      console.log(`  ${s}x${s} (from dock.png)`);
    }
  } else {
    // Fallback: just resize icon.png
    for (const s of appSizes) {
      const buf = await sharp(iconSrc)
        .resize(s, s, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      tempFiles.push(writeTempPng(buf, `app_${s}`));
      console.log(`  ${s}x${s} (from icon.png)`);
    }
  }

  const icoBuffer = await pngToIco(tempFiles);
  fs.writeFileSync(path.join(buildDir, "icon.ico"), icoBuffer);
  console.log("  -> build/icon.ico\n");

  // ── Cleanup ───────────────────────────────────────────────
  [...tempFiles, ...trayTempFiles].forEach((f) => {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  });

  console.log("Done!");
  console.log("  macOS dock:  build/icon.icns (unchanged)");
  console.log("  macOS tray:  build/tray.png + tray@2x.png");
  console.log("  Win app:     build/icon.ico (from dock.png)");
  console.log("  Win tray:    build/tray.ico");
  console.log("  Linux tray:  build/tray.png");
  console.log("  Style:       white plate + transparent glyph");
}

main().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
