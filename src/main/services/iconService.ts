import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { nanoid } from 'nanoid'
import type { PresetIcon } from '@shared/types'

const PRESET_ICONS: PresetIcon[] = ['claude', 'codex', 'zhipu', 'minimax', 'xiaomi', 'deepseek']

function getIconsDir(): string {
  const iconsDir = path.join(app.getPath('userData'), 'icons')
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true })
  }
  return iconsDir
}

export function getPresetIcons(): PresetIcon[] {
  return PRESET_ICONS
}

export async function uploadIcon(buffer: Buffer, originalFilename: string): Promise<string> {
  const iconsDir = getIconsDir()
  const ext = path.extname(originalFilename) || '.png'
  const filename = `${nanoid()}${ext}`
  const filePath = path.join(iconsDir, filename)

  await fs.promises.writeFile(filePath, buffer)

  return filePath
}

export function getUploadedIcons(): string[] {
  const iconsDir = getIconsDir()
  try {
    const files = fs.readdirSync(iconsDir)
    return files
      .filter((f) => /\.(png|jpg|jpeg|svg|webp)$/i.test(f))
      .map((f) => path.join(iconsDir, f))
  } catch {
    return []
  }
}

export function deleteIcon(iconPath: string): boolean {
  try {
    if (fs.existsSync(iconPath)) {
      fs.unlinkSync(iconPath)
      return true
    }
    return false
  } catch {
    return false
  }
}
