#!/usr/bin/env node

/* eslint-env node */

/**
 * Icon generation script for CC Use (macOS only)
 *
 * Tray icon style:
 *   Mostly-white rounded-rect background with the original icon area cut out
 *   to transparency ("white plate + transparent glyph").
 *
 * Output (written into src-tauri/icons/):
 *   - tray.png       (22x22)   macOS tray base
 *   - tray.rgba      (22x22)   macOS runtime override (include_bytes)
 *   - tray@2x.rgba   (44x44)   macOS Retina runtime override (include_bytes)
 *   - tray@2x.png    (44x44)   macOS Retina representation
 *
 * Usage: pnpm generate:icons
 */

import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Buffer } from 'node:buffer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// Tauri stores bundle resources under src-tauri/icons.
// This script reads source icons from there and overwrites the generated outputs in-place.
const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons')

// Tray tuning
// - Plate color: slightly off-white to avoid harsh white
// - Padding ratios: keep modest so the image stays compact (smaller click area)
const PLATE_COLOR = '#f3f4f6'
// Smaller padding => larger perceived glyph (closer to Electron nativeImage resizing)
// NOTE: 22px assets clamp to >=1px padding anyway; this mainly affects 44px (Retina).
const PLATE_PADDING_RATIO = 0.03
const GLYPH_PADDING_RATIO = 0.1
// Make the plate/border around the cutout slightly thicker.
// (+1px matches the previous style while improving readability.)
const GLYPH_PADDING_PLUS_PX_1X = 1
const GLYPH_PADDING_PLUS_PX_2X = 2

// --- Helpers ---

function circleSvg(size, color, padding) {
  const cx = size / 2
  const cy = size / 2
  const r = Math.max(1, (size - padding * 2) / 2)
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>
    </svg>`,
  )
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
  const platePadding = Math.max(Math.round(size * PLATE_PADDING_RATIO), 1)
  const baseGlyphPadding = Math.max(Math.round(size * GLYPH_PADDING_RATIO), 1)
  const glyphPaddingPlus = size >= 44 ? GLYPH_PADDING_PLUS_PX_2X : GLYPH_PADDING_PLUS_PX_1X
  const glyphPadding = baseGlyphPadding + glyphPaddingPlus

  // Background: only a circular white content area, outer area stays transparent
  const { data: bg, info: bgInfo } = await sharp(circleSvg(size, PLATE_COLOR, platePadding))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const inner = size - glyphPadding * 2

  let pipeline = sharp(sourceBuffer).ensureAlpha()
  try {
    // Remove transparent margins so the cutout appears larger.
    pipeline = pipeline.trim()
  } catch {
    // ignore
  }

  const { data: icon, info: iconInfo } = await pipeline
    .resize(inner, inner, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true })

  if (bgInfo.width !== size || bgInfo.height !== size) {
    throw new Error('Unexpected background size')
  }
  if (iconInfo.width !== inner || iconInfo.height !== inner) {
    throw new Error('Unexpected icon size')
  }

  // Punch out alpha in the icon region
  for (let iy = 0; iy < inner; iy++) {
    for (let ix = 0; ix < inner; ix++) {
      const bgX = ix + glyphPadding
      const bgY = iy + glyphPadding
      const bgIdx = (bgY * size + bgX) * 4
      const iconIdx = (iy * inner + ix) * 4

      const iconAlpha = icon[iconIdx + 3]
      if (iconAlpha === 0) continue

      // Keep plate RGB as-is, adjust alpha only
      bg[bgIdx + 3] = Math.max(0, 255 - iconAlpha)
    }
  }

  return sharp(bg, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}

function writeRgbaFromPng(pngBuffer, outPath) {
  return sharp(pngBuffer).ensureAlpha().raw().toBuffer().then((raw) => {
    fs.writeFileSync(outPath, raw)
  })
}

// --- Main ---

async function main() {
  const iconSrcPath = path.join(iconsDir, 'icon.png')

  if (!fs.existsSync(iconSrcPath)) {
    globalThis.console.error('Error: src-tauri/icons/icon.png not found.')
    globalThis.process.exit(1)
  }

  const iconSrc = fs.readFileSync(iconSrcPath)
  globalThis.console.log('Source icons loaded\n')

  // ── Tray icons (white plate + transparent cutout) ─────
  globalThis.console.log('Tray icons (white plate + transparent cutout):')

  // macOS tray base + Retina
  // macOS menu bar items size is derived from the image width; keep it small.
  const tray22 = await trayCutoutWhite(iconSrc, 22)
  fs.writeFileSync(path.join(iconsDir, 'tray.png'), tray22)
  await writeRgbaFromPng(tray22, path.join(iconsDir, 'tray.rgba'))
  globalThis.console.log('  tray.png (22x22)')
  globalThis.console.log('  tray.rgba (22x22 raw)')

  const tray44 = await trayCutoutWhite(iconSrc, 44)
  fs.writeFileSync(path.join(iconsDir, 'tray@2x.png'), tray44)
  await writeRgbaFromPng(tray44, path.join(iconsDir, 'tray@2x.rgba'))
  globalThis.console.log('  tray@2x.png (44x44)')
  globalThis.console.log('  tray@2x.rgba (44x44 raw)')

  globalThis.console.log('\nDone!')
  globalThis.console.log('  macOS dock:  src-tauri/icons/icon.icns (unchanged)')
  globalThis.console.log('  macOS tray:  src-tauri/icons/tray.png (+ tray.rgba / tray@2x.rgba runtime)')
  globalThis.console.log('  Style:       white plate + transparent glyph')
}

main().catch((err) => {
  globalThis.console.error('Icon generation failed:', err)
  globalThis.process.exit(1)
})
