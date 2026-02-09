import { app, BrowserWindow, nativeImage, Tray, Menu, dialog } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { initDatabase, closeDatabase } from './database'
import { registerIpcHandlers } from './ipc/handlers'
import { startProxy, stopProxy, getProxyStatus } from './services/proxy'
import { listProjects } from './services/projectService'
import { launchTerminal } from './services/terminal'
import { getGlobalSettings } from './services/settingsService'
import { setUpdaterWindow, cleanupOldUpdates } from './services/updaterService'
import { IPC_CHANNELS } from '../shared/types/ipc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null
let cachedCloseToTray = true

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Prevent multiple instances in dev (and production)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

// Tray menu labels
const trayLabels = {
  zh: {
    show: '显示窗口',
    hide: '隐藏窗口',
    quit: '退出',
    proxyRunning: '代理: ● 运行中',
    proxyStopped: '代理: ○ 已停止',
    startProxy: '启动代理',
    stopProxy: '停止代理',
    recentProjects: '最近项目',
    noRecentProjects: '暂无最近项目',
    stopProxyConfirm: '确认关闭代理？',
    stopProxyWarning: '关闭后，无法记录使用量',
    confirm: '确认',
    cancel: '取消',
  },
  en: {
    show: 'Show Window',
    hide: 'Hide Window',
    quit: 'Quit',
    proxyRunning: 'Proxy: ● Running',
    proxyStopped: 'Proxy: ○ Stopped',
    startProxy: 'Start Proxy',
    stopProxy: 'Stop Proxy',
    recentProjects: 'Recent Projects',
    noRecentProjects: 'No Recent Projects',
    stopProxyConfirm: 'Stop proxy?',
    stopProxyWarning: 'Usage tracking will be disabled when proxy is stopped',
    confirm: 'Confirm',
    cancel: 'Cancel',
  },
}

function getTrayLang(): 'zh' | 'en' {
  const locale = app.getLocale()
  return locale.startsWith('zh') ? 'zh' : 'en'
}

// 尽早设置 Dock 图标，避免闪现默认 Electron 图标
if (process.platform === 'darwin' && isDev) {
  try {
    const dockPath = join(process.cwd(), 'build', 'dock.png')
    let image = nativeImage.createFromPath(dockPath)
    if (image.isEmpty()) {
      const iconPath = join(process.cwd(), 'build', 'icon.png')
      image = nativeImage.createFromPath(iconPath)
    }
    if (!image.isEmpty()) {
      app.dock.setIcon(image)
    }
  } catch {
    // ignore
  }
}

function getTrayIcon(): Electron.NativeImage {
  // Tray style: light plate + transparent cutout
  // macOS: load tray.png and add tray@2x.png as Retina representation (if present)
  // Windows: tray.ico
  // Linux: tray.png
  if (process.platform === 'win32') {
    const iconPath = isDev
      ? join(process.cwd(), 'build', 'tray.ico')
      : join(process.resourcesPath, 'build', 'tray.ico')
    return nativeImage.createFromPath(iconPath)
  }

  const basePath = isDev ? join(process.cwd(), 'build') : join(process.resourcesPath, 'build')
  const tray1xPath = join(basePath, 'tray.png')
  const tray2xPath = join(basePath, 'tray@2x.png')

  const image = nativeImage.createFromPath(tray1xPath)
  if (process.platform === 'darwin') {
    try {
      const rep2x = nativeImage.createFromPath(tray2xPath)
      if (!rep2x.isEmpty()) {
        image.addRepresentation({ scaleFactor: 2, buffer: rep2x.toPNG() })
      }
    } catch {
      // ignore
    }
  }

  return image
}

function getAppIcon(): Electron.NativeImage {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const iconPath = isDev
    ? join(process.cwd(), 'build', iconName)
    : join(process.resourcesPath, 'build', iconName)
  return nativeImage.createFromPath(iconPath)
}

function showWindow() {
  if (!mainWindow) {
    createWindow()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
  if (process.platform === 'darwin') {
    app.dock.show()
  }
}

function hideWindow() {
  if (mainWindow) {
    mainWindow.hide()
  }
  if (process.platform === 'darwin') {
    app.dock.hide()
  }
}

function notifyProxyStatusChanged(source?: string) {
  const status = getProxyStatus()
  mainWindow?.webContents.send(IPC_CHANNELS.PROXY_STATUS_CHANGED, {
    isRunning: status.isRunning,
    port: status.port,
    source,
  })
}

async function buildTrayMenu(): Promise<Menu> {
  const labels = trayLabels[getTrayLang()]
  const isWindowVisible = mainWindow?.isVisible() ?? false
  const proxyStatus = getProxyStatus()

  let projects: Awaited<ReturnType<typeof listProjects>> = []
  try {
    projects = await listProjects()
  } catch {
    // ignore
  }
  const recentProjects = projects.filter((p) => p.lastOpenedAt).slice(0, 10)

  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: isWindowVisible ? labels.hide : labels.show,
      click: () => {
        if (mainWindow?.isVisible()) {
          hideWindow()
        } else {
          showWindow()
        }
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: proxyStatus.isRunning ? labels.proxyRunning : labels.proxyStopped,
      enabled: false,
    },
    {
      label: proxyStatus.isRunning ? labels.stopProxy : labels.startProxy,
      click: async () => {
        try {
          if (proxyStatus.isRunning) {
            const { response } = await dialog.showMessageBox({
              type: 'question',
              buttons: [labels.cancel, labels.confirm],
              defaultId: 0,
              cancelId: 0,
              title: labels.stopProxyConfirm,
              message: labels.stopProxyConfirm,
              detail: labels.stopProxyWarning,
              icon: getAppIcon(),
            })
            if (response === 0) return
            await stopProxy()
          } else {
            await startProxy()
          }
          notifyProxyStatusChanged('tray')
        } catch (error) {
          console.error('Tray proxy toggle failed:', error)
        }
        updateTrayMenu()
      },
    },
    { type: 'separator' },
  ]

  if (recentProjects.length > 0) {
    menuTemplate.push({
      label: labels.recentProjects,
      submenu: recentProjects.map((project) => ({
        label: project.name,
        click: async () => {
          try {
            await launchTerminal(project.id)
          } catch (error) {
            console.error('Failed to launch terminal from tray:', error)
          }
        },
      })),
    })
  } else {
    menuTemplate.push({
      label: labels.noRecentProjects,
      enabled: false,
    })
  }

  menuTemplate.push(
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  )

  return Menu.buildFromTemplate(menuTemplate)
}

async function updateTrayMenu() {
  if (!tray) return
  // Also refresh cached closeToTray setting
  try {
    const settings = await getGlobalSettings()
    cachedCloseToTray = settings.closeToTray
  } catch {
    // keep previous cached value
  }
  const menu = await buildTrayMenu()
  tray.setContextMenu(menu)
}

async function createTray() {
  const icon = getTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('CC Use')

  // Windows/Linux: left click toggles window visibility
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (mainWindow?.isVisible()) {
        hideWindow()
      } else {
        showWindow()
      }
      updateTrayMenu()
    })
  }

  await updateTrayMenu()

  // Refresh tray menu every 30 seconds
  trayRefreshTimer = setInterval(() => {
    updateTrayMenu()
  }, 30000)
}

function createWindow() {
  // Hide default menu bar on Windows/Linux (macOS uses system menu bar)
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {}),
    backgroundColor: '#141414',
  })

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('close', (e) => {
    if (isQuitting) return

    if (cachedCloseToTray) {
      e.preventDefault()
      hideWindow()
      updateTrayMenu()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  initDatabase()
  registerIpcHandlers()

  // Clean up old update files
  cleanupOldUpdates()

  // Load initial settings
  try {
    const settings = await getGlobalSettings()
    cachedCloseToTray = settings.closeToTray
  } catch {
    // keep default
  }

  // Start proxy server
  try {
    await startProxy()
    console.log('Proxy server started')
  } catch (error) {
    console.error('Failed to start proxy server:', error)
  }

  createWindow()
  if (mainWindow) {
    setUpdaterWindow(mainWindow)
  }
  await createTray()

  app.on('activate', () => {
    if (!mainWindow) {
      createWindow()
      if (mainWindow) {
        setUpdaterWindow(mainWindow)
      }
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
    if (process.platform === 'darwin') {
      app.dock.show()
    }
  })
})

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed - tray keeps the app alive
  // On macOS this is already the default behavior
})

app.on('before-quit', async () => {
  isQuitting = true
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer)
    trayRefreshTimer = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
  await stopProxy()
  closeDatabase()
})
