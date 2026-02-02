import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = process.cwd()
const srcSvg = process.env.SRC_SVG
  ? path.resolve(root, process.env.SRC_SVG)
  : path.join(root, 'src', 'renderer', 'assets', 'icon.svg')
const outDir = path.join(root, 'build')
const iconPng = path.join(outDir, 'icon.png')
const dockPng = path.join(outDir, 'dock.png')
const iconIco = path.join(outDir, 'icon.ico')
const iconIcns = path.join(outDir, 'icon.icns')
const iconsetDir = path.join(outDir, 'icon.iconset')

function createRoundedRectSvg({ size, margin = 0, radius, fill = '#ffffff' }) {
  const rectSize = size - margin * 2
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${margin}" y="${margin}" width="${rectSize}" height="${rectSize}" rx="${radius}" ry="${radius}" fill="${fill}"/>
    </svg>
  `)
}

async function createDockStylePngBuffer({ size }) {
  // macOS Dock 图标一般更“实心”，需要更少留白，否则看起来会偏小。
  // 这里采用圆角白底 + 居中标记的形式，并保留适度安全边距（避免看起来过大）。
  const bgMargin = Math.round(size * 0.08)
  const bgSize = size - bgMargin * 2
  const bgRadius = Math.round(bgSize * 0.28)
  const markPadding = Math.round(size * 0.19)
  const markSize = size - markPadding * 2

  const mark = await sharp(srcSvg).resize(markSize, markSize).png({ compressionLevel: 9 }).toBuffer()
  const roundedRectSvg = createRoundedRectSvg({ size, margin: bgMargin, radius: bgRadius, fill: '#ffffff' })

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: roundedRectSvg, top: 0, left: 0 },
      { input: mark, gravity: 'center' },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

if (!existsSync(srcSvg)) {
  console.error(`Missing source SVG: ${srcSvg}`)
  process.exit(1)
}

await mkdir(outDir, { recursive: true })

// 1) Base PNG for Linux (and general usage)
await sharp(srcSvg)
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(iconPng)

// 1.1) Dock-only PNG (rounded white background + smaller mark)
{
  const size = 1024
  const dockBuf = await createDockStylePngBuffer({ size })
  await sharp(dockBuf).toFile(dockPng)
}

// 2) Windows .ico
const icoPngs = await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map((size) =>
    sharp(srcSvg).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
  )
)
const icoBuf = await pngToIco(icoPngs)
await writeFile(iconIco, icoBuf)

// 3) macOS .icns via iconutil (needs an iconset folder)
await mkdir(iconsetDir, { recursive: true })

// macOS 使用更贴近 Dock 视觉的底板版本，避免图标在 Dock 上显得过小。
const macBaseSize = 1024
const macBaseBuf = await createDockStylePngBuffer({ size: macBaseSize })

const macSizes = [16, 32, 128, 256, 512]
for (const size of macSizes) {
  const file1x = path.join(iconsetDir, `icon_${size}x${size}.png`)
  const file2x = path.join(iconsetDir, `icon_${size}x${size}@2x.png`)

  await sharp(macBaseBuf).resize(size, size).png({ compressionLevel: 9 }).toFile(file1x)
  await sharp(macBaseBuf).resize(size * 2, size * 2).png({ compressionLevel: 9 }).toFile(file2x)
}

try {
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', iconIcns], {
    stdio: 'inherit',
  })
} catch (e) {
  console.error('Failed to run iconutil (macOS only).')
  throw e
}

console.log('Generated:')
console.log(`- ${path.relative(root, iconPng)}`)
console.log(`- ${path.relative(root, dockPng)}`)
console.log(`- ${path.relative(root, iconIco)}`)
console.log(`- ${path.relative(root, iconIcns)}`)
