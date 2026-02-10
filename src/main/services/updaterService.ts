import { autoUpdater } from 'electron-updater'
import { BrowserWindow, shell, app, powerMonitor } from 'electron'
import { IPC_CHANNELS } from '@shared/types/ipc'
import type { UpdateCheckResult, UpdateProgressInfo } from '@shared/types'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

let mainWindow: BrowserWindow | null = null
let cachedDownloadUrl: string | null = null
let downloadedFilePath: string | null = null
let useElectronUpdater = false
let lastCheckTime = 0

// Minimum interval between checks: 12 hours
const MIN_CHECK_INTERVAL = 12 * 60 * 60 * 1000
// Delay before first auto check after app start: 30 seconds
const INITIAL_CHECK_DELAY = 30 * 1000

// Get updates cache directory
function getUpdatesCacheDir(): string {
  const cacheDir = path.join(app.getPath('userData'), 'updates')
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  return cacheDir
}

// Clean up old update files on app start
export function cleanupOldUpdates(): void {
  const cacheDir = getUpdatesCacheDir()
  const currentVersion = app.getVersion()

  try {
    const files = fs.readdirSync(cacheDir)
    for (const file of files) {
      // Extract version from filename like "CC Use-1.0.0-mac-arm64.dmg" or "CC.Use-1.0.0-mac-arm64.dmg"
      const versionMatch = file.match(/CC[.\- ]Use[.\- ](\d+\.\d+\.\d+)/i)
      if (versionMatch) {
        const fileVersion = versionMatch[1]
        if (compareVersions(currentVersion, fileVersion) >= 0) {
          // Current version is same or newer, safe to delete
          const filePath = path.join(cacheDir, file)
          console.log('Cleaning up old update file:', filePath)
          fs.unlinkSync(filePath)
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning up old updates:', err)
  }
}

// Get cache size info
export function getUpdatesCacheInfo(): { size: number; files: string[] } {
  const cacheDir = getUpdatesCacheDir()
  let totalSize = 0
  const files: string[] = []

  try {
    const entries = fs.readdirSync(cacheDir)
    for (const entry of entries) {
      const filePath = path.join(cacheDir, entry)
      const stat = fs.statSync(filePath)
      if (stat.isFile()) {
        totalSize += stat.size
        files.push(entry)
      }
    }
  } catch {
    // Ignore errors
  }

  return { size: totalSize, files }
}

// Clear all cached updates
export function clearUpdatesCache(): number {
  const cacheDir = getUpdatesCacheDir()
  let deletedCount = 0

  try {
    const files = fs.readdirSync(cacheDir)
    for (const file of files) {
      const filePath = path.join(cacheDir, file)
      fs.unlinkSync(filePath)
      deletedCount++
    }
  } catch (err) {
    console.error('Error clearing updates cache:', err)
  }

  // Also clear the current download path
  downloadedFilePath = null

  return deletedCount
}

export function setUpdaterWindow(win: BrowserWindow) {
  mainWindow = win

  autoUpdater.on('error', (err) => {
    console.error('autoUpdater error:', err)
  })

  autoUpdater.on('download-progress', (progress) => {
    const info: UpdateProgressInfo = {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    }
    mainWindow?.webContents.send(IPC_CHANNELS.APP_UPDATE_PROGRESS, info)
  })

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED)
  })

  // Start auto update check
  startAutoUpdateCheck()
}

// Auto check for updates - event driven, not interval based
function startAutoUpdateCheck() {
  // First check after delay
  setTimeout(() => {
    performAutoCheck()
  }, INITIAL_CHECK_DELAY)

  // Check when computer resumes from sleep
  powerMonitor.on('resume', () => {
    console.log('System resumed from sleep, checking for updates...')
    performAutoCheck()
  })

  // Check when window gains focus (but respect minimum interval)
  mainWindow?.on('focus', () => {
    performAutoCheck()
  })
}

async function performAutoCheck() {
  // Respect minimum interval between checks
  const now = Date.now()
  if (now - lastCheckTime < MIN_CHECK_INTERVAL) {
    return
  }
  lastCheckTime = now

  try {
    const currentVersion = app.getVersion()
    const result = await checkForUpdates(currentVersion)
    if (result.hasUpdate) {
      // Notify renderer about available update (shows in-app banner)
      mainWindow?.webContents.send(IPC_CHANNELS.APP_UPDATE_AVAILABLE, result)
    }
  } catch (err) {
    console.error('Auto update check failed:', err)
  }
}

// Strip HTML tags and decode common entities to plain text
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Fetch CHANGELOG.md from GitHub and extract notes for a specific version
async function fetchChangelogForVersion(version: string): Promise<string> {
  // Prefer reading the changelog from the release tag to match the released artifact,
  // fall back to main branch if the tag doesn't include CHANGELOG.md.
  const candidates = [
    `https://raw.githubusercontent.com/mipawn/cc-use/v${version}/CHANGELOG.md`,
    'https://raw.githubusercontent.com/mipawn/cc-use/main/CHANGELOG.md',
  ]

  let lastError: unknown
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'cc-use' } })
      if (!response.ok) {
        lastError = new Error(`Failed to fetch CHANGELOG.md: ${response.status}`)
        continue
      }
      const content = await response.text()
      return parseChangelogVersion(content, version)
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to fetch CHANGELOG.md')
}

// Parse changelog content and extract section for a specific version
function parseChangelogVersion(changelog: string, version: string): string {
  // Match ## [version] header and capture everything until the next ## or ---\n## or end
  const escapedVersion = version.replace(/\./g, '\\.')
  const regex = new RegExp(
    `## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n---\\s*\\n|\\n## \\[|$)`,
  )
  const match = changelog.match(regex)
  if (!match) return ''
  return match[1].trim()
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  // Reset state
  useElectronUpdater = false
  downloadedFilePath = null

  // In dev mode, electron-updater skips check, go directly to GitHub API
  if (!app.isPackaged) {
    return checkForUpdatesViaGitHub(currentVersion)
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    if (result && result.updateInfo) {
      const latestVersion = result.updateInfo.version
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      if (hasUpdate) {
        useElectronUpdater = true
        // Also prepare fallback download URL via GitHub API
        // in case electron-updater download fails (e.g. unsigned app on macOS)
        try {
          await checkForUpdatesViaGitHub(currentVersion)
          // cachedDownloadUrl is set inside checkForUpdatesViaGitHub
          console.log('Fallback download URL prepared:', cachedDownloadUrl)
        } catch {
          console.warn('Failed to prepare fallback download URL')
        }
      }
      let releaseNotes = ''
      if (typeof result.updateInfo.releaseNotes === 'string') {
        releaseNotes = stripHtml(result.updateInfo.releaseNotes)
      }

      // Prefer CHANGELOG.md over GitHub auto-generated release notes.
      // This avoids showing the default "Full Changelog" compare link.
      if (hasUpdate) {
        try {
          const changelogNotes = await fetchChangelogForVersion(latestVersion)
          if (changelogNotes && changelogNotes.trim().length > 0) {
            releaseNotes = changelogNotes
          }
        } catch {
          // Ignore and keep electron-updater notes
        }
      }

      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseUrl: `https://github.com/mipawn/cc-use/releases/tag/v${latestVersion}`,
        releaseNotes,
      }
    }
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseUrl: 'https://github.com/mipawn/cc-use/releases',
      releaseNotes: '',
    }
  } catch {
    // Fallback to GitHub API
    return checkForUpdatesViaGitHub(currentVersion)
  }
}

async function checkForUpdatesViaGitHub(currentVersion: string): Promise<UpdateCheckResult> {
  const response = await fetch('https://api.github.com/repos/mipawn/cc-use/releases/latest', {
    headers: { 'User-Agent': 'cc-use' },
  })
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`)
  }
  const data = await response.json()
  const latestVersion = (data.tag_name || '').replace(/^v/, '')
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0

  // Find download URL for current platform
  let downloadUrl: string | undefined
  if (hasUpdate && data.assets) {
    const platform = process.platform
    const arch = process.arch
    for (const asset of data.assets) {
      const name: string = asset.name?.toLowerCase() || ''
      if (platform === 'darwin' && name.endsWith('.dmg') && name.includes(arch)) {
        downloadUrl = asset.browser_download_url
        break
      }
      if (platform === 'darwin' && name.endsWith('.dmg')) {
        downloadUrl = asset.browser_download_url
      }
      if (platform === 'win32' && name.endsWith('.exe')) {
        downloadUrl = asset.browser_download_url
      }
    }
  }
  cachedDownloadUrl = downloadUrl || null

  // Prefer CHANGELOG.md over release body (which may only contain "Full Changelog" links).
  let releaseNotes = data.body ? stripHtml(data.body) : ''
  if (hasUpdate) {
    try {
      const changelogNotes = await fetchChangelogForVersion(latestVersion)
      if (changelogNotes && changelogNotes.trim().length > 0) {
        releaseNotes = changelogNotes
      }
    } catch {
      // Ignore and keep release body
    }
  }

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    releaseUrl: data.html_url || 'https://github.com/mipawn/cc-use/releases',
    releaseNotes,
    downloadUrl,
  }
}

export async function downloadUpdate(): Promise<void> {
  // If electron-updater check succeeded, try it first with a timeout
  if (useElectronUpdater) {
    try {
      const DOWNLOAD_TIMEOUT = 5 * 60 * 1000 // 5 minutes timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('electron-updater download timeout')), DOWNLOAD_TIMEOUT),
      )
      await Promise.race([autoUpdater.downloadUpdate(), timeoutPromise])
      return
    } catch (err) {
      console.warn('electron-updater download failed, falling back to manual download:', err)
      // Fall through to manual download
    }
  }

  // Manual download using cached URL
  if (!cachedDownloadUrl) {
    // Last resort: try to fetch download URL from GitHub API
    try {
      const currentVersion = app.getVersion()
      await checkForUpdatesViaGitHub(currentVersion)
    } catch {
      // Ignore
    }
  }

  if (!cachedDownloadUrl) {
    throw new Error('No download URL available')
  }

  downloadedFilePath = await manualDownload(cachedDownloadUrl)
  mainWindow?.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED)
}

async function manualDownload(url: string): Promise<string> {
  const downloadDir = getUpdatesCacheDir()
  const fileName = decodeURIComponent(path.basename(new URL(url).pathname))
  const filePath = path.join(downloadDir, fileName)

  let totalBytes = 0
  let receivedBytes = 0
  let lastTime = Date.now()
  let lastBytes = 0

  return new Promise((resolve, reject) => {
    const downloadWithRedirect = (requestUrl: string) => {
      const urlObj = new URL(requestUrl)
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: {
          'User-Agent': 'cc-use',
        },
      }

      const req = https.get(options, (response) => {
        // Handle redirects (GitHub uses 302)
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307
        ) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            console.log('Redirecting to:', redirectUrl)
            downloadWithRedirect(redirectUrl)
            return
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`))
          return
        }

        totalBytes = parseInt(response.headers['content-length'] || '0', 10)
        console.log('Starting download, total size:', totalBytes)

        const file = fs.createWriteStream(filePath)

        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          file.write(chunk)

          const now = Date.now()
          const elapsed = (now - lastTime) / 1000
          if (elapsed >= 0.3) {
            const bytesPerSecond = (receivedBytes - lastBytes) / elapsed
            const percent = totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0

            mainWindow?.webContents.send(IPC_CHANNELS.APP_UPDATE_PROGRESS, {
              percent,
              transferred: receivedBytes,
              total: totalBytes,
              bytesPerSecond,
            } as UpdateProgressInfo)

            lastTime = now
            lastBytes = receivedBytes
          }
        })

        response.on('end', () => {
          file.end(() => {
            console.log('Download complete:', filePath)
            resolve(filePath)
          })
        })

        response.on('error', (err) => {
          file.close()
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
          }
          reject(err)
        })

        file.on('error', (err) => {
          file.close()
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
          }
          reject(err)
        })
      })

      req.on('error', (err) => {
        reject(err)
      })
    }

    downloadWithRedirect(url)
  })
}

export async function installUpdate(): Promise<{ success: boolean; error?: string }> {
  // If electron-updater was used, use quitAndInstall
  if (useElectronUpdater) {
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  }

  // Otherwise open the downloaded file
  if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
    console.log('Opening downloaded file:', downloadedFilePath)
    const error = await shell.openPath(downloadedFilePath)
    if (error) {
      console.error('Failed to open downloaded file:', error)
      return { success: false, error }
    }
    return { success: true }
  }

  console.error('No downloaded file found, downloadedFilePath:', downloadedFilePath)
  return { success: false, error: 'No downloaded file found' }
}

export function getDownloadedFilePath(): string | null {
  return downloadedFilePath
}
