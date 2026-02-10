import { app, BrowserWindow, nativeImage, Tray, Menu, dialog, globalShortcut } from 'electron'
import { join, dirname } from 'path'
import { readFileSync } from 'fs'
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
let splashWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null
let cachedCloseToTray = true

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Windows: ensure taskbar/shortcut grouping uses our AppUserModelID.
// This helps the pinned/taskbar icon resolve to the app's icon instead of Electron's default.
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.mipawn.cc-use')
  } catch {
    // ignore
  }
}

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

function getDockIcon(): Electron.NativeImage {
  const basePath = isDev ? join(process.cwd(), 'build') : join(process.resourcesPath, 'build')
  const dockPath = join(basePath, 'dock.png')
  let image = nativeImage.createFromPath(dockPath)
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(join(basePath, 'icon.png'))
  }
  return image
}

function ensureAppIcons() {
  if (process.platform === 'darwin') {
    try {
      const image = getDockIcon()
      if (!image.isEmpty()) app.dock.setIcon(image)
    } catch {
      // ignore
    }
    return
  }

  if (mainWindow) {
    try {
      const image = getAppIcon()
      if (!image.isEmpty()) mainWindow.setIcon(image)
    } catch {
      // ignore
    }
  }
}

function isMainWindowActuallyVisible(): boolean {
  if (!mainWindow) return false
  if (mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) return false
  // On macOS the app can be hidden while window still reports visible.
  if (process.platform === 'darwin') {
    try {
      if (app.isHidden()) return false
    } catch {
      // ignore
    }
  }
  return mainWindow.isVisible()
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
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  if (process.platform === 'darwin') {
    app.dock.show()
  }
  ensureAppIcons()
}

function hideWindow() {
  if (mainWindow) {
    mainWindow.hide()
  }
  if (process.platform === 'darwin') {
    app.dock.hide()
  }
}

function createSplashWindow() {
  if (splashWindow) return splashWindow

  const background = '#0f172a'
  
  // Try to load logo
  let logoBase64 = ''
  try {
    const iconPath = isDev 
      ? join(process.cwd(), 'build', 'icon.png')
      : join(process.resourcesPath, 'build', 'icon.png')
    
    const logoBuffer = readFileSync(iconPath)
    logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`
  } catch (e) {
    console.error('Splash icon not found or unreadable:', e)
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>CC Use 启动中</title>
  <style>
    :root {
      --bg: ${background};
      --primary: #3b82f6;
      --secondary: #6366f1;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    body {
      margin: 0;
      height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      overflow: hidden;
      user-select: none;
      display: flex;
      justify-content: center;
      align-items: center;
      /* Tech grid background */
      background-image: 
        linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
      background-size: 30px 30px;
    }
    
    .glow-spot {
      position: absolute;
      width: 400px;
      height: 400px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.12) 0%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      z-index: -1;
    }

    .content {
      text-align: center;
      position: relative;
      z-index: 10;
      width: 100%;
      padding: 20px;
      box-sizing: border-box;
    }

    .logo-wrapper {
      position: relative;
      width: 80px;
      height: 80px;
      margin: 0 auto 20px;
      animation: float 4s ease-in-out infinite;
    }
    
    .logo {
      width: 100%;
      height: 100%;
      object-fit: contain;
      filter: drop-shadow(0 0 15px rgba(59, 130, 246, 0.4));
    }
    
    .logo-ring {
      position: absolute;
      top: -10%;
      left: -10%;
      width: 120%;
      height: 120%;
      border: 1px dashed rgba(99, 102, 241, 0.3);
      border-radius: 50%;
      animation: spin 10s linear infinite;
    }

    h1 {
      font-size: 24px;
      font-weight: 700;
      margin: 0 0 8px;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #fff 30%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 2px;
      text-transform: uppercase;
      margin-bottom: 30px;
      opacity: 0.8;
      font-weight: 500;
    }
    
    .loading-bar-container {
      width: 180px;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      margin: 0 auto 12px;
      position: relative;
      overflow: hidden;
    }
    
    .loading-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 40%;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      box-shadow: 0 0 10px var(--primary);
      border-radius: 3px;
      animation: loading-slide 1.5s ease-in-out infinite;
    }

    .status-text {
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 11px;
      color: #64748b;
      height: 16px;
      transition: opacity 0.2s;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    @keyframes loading-slide {
      0% { left: -40%; }
      50% { left: 30%; width: 60%; }
      100% { left: 100%; width: 40%; }
    }
  </style>
</head>
<body>
  <div class="glow-spot"></div>
  <div class="content">
    <div class="logo-wrapper">
      <div class="logo-ring"></div>
      ${logoBase64 ? `<img src="${logoBase64}" class="logo" />` : ''}
    </div>
    <h1>CC Use</h1>
    <div class="subtitle">Developer Productivity Kit</div>
    
    <div class="loading-bar-container">
      <div class="loading-bar"></div>
    </div>
    <div class="status-text" id="status">INITIALIZING...</div>
  </div>

  <script>
    const steps = [
      '正在初始化引擎...',
      '加载本地配置...',
      '同步开发环境...',
      '连接代理服务...',
      '准备就绪...'
    ];
    let stepIndex = 0;
    const el = document.getElementById('status');
    
    setInterval(() => {
      stepIndex = (stepIndex + 1) % steps.length;
      el.style.opacity = 0;
      setTimeout(() => {
        el.innerText = steps[stepIndex];
        el.style.opacity = 1;
      }, 200);
    }, 800);
  </script>
</body>
</html>`

  splashWindow = new BrowserWindow({
    width: 380,
    height: 380, // Slightly taller for new layout
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: false,
    show: true,
    alwaysOnTop: true,
    transparent: true, // Enable transparency for rounded corners if needed, though we use dark bg
    backgroundColor: '#00000000', // Transparent base for custom css border-radius
    hasShadow: true,
    icon: getAppIcon(),
    webPreferences: {
      devTools: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  // To allow rounded corners on the window itself nicely, we can update the body style to have border-radius
  // But standard frameless works too. Let's stick to standard solid background for safety on all platforms, 
  // or use the color provided in CSS.
  // Actually, setting transparent: true and backgroundColor: '#00000000' allows CSS to control the shape completely.
  
  // Update HTML body to have border radius and background
  const finalHtml = html.replace('body {', 'body { border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 20px 50px rgba(0,0,0,0.5); backdrop-filter: blur(10px);')

  splashWindow.center()
  splashWindow.setSkipTaskbar(true)

  // Use a data URL
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(finalHtml)}`)

  splashWindow.on('closed', () => {
    splashWindow = null
  })

  return splashWindow
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
  const isWindowVisible = isMainWindowActuallyVisible()
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
        if (isMainWindowActuallyVisible()) {
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

  // Keep menu text in sync even when window visibility changes elsewhere.
  tray.on('click', () => {
    updateTrayMenu()
  })
  tray.on('right-click', () => {
    updateTrayMenu()
  })

  // Windows/Linux: left click toggles window visibility
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      if (isMainWindowActuallyVisible()) {
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

  // Splash screen: show immediately, load main window in background.
  createSplashWindow()

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
    },
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {}),
    backgroundColor: '#0f172a',
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
    }

    mainWindow.show()
    mainWindow.focus()
    ensureAppIcons()
  })

  // Sync tray menu label with the real window state.
  mainWindow.on('show', () => {
    ensureAppIcons()
    updateTrayMenu()
  })
  mainWindow.on('hide', () => {
    updateTrayMenu()
  })
  mainWindow.on('minimize', () => {
    updateTrayMenu()
  })
  mainWindow.on('restore', () => {
    ensureAppIcons()
    updateTrayMenu()
  })

  // Ensure DevTools can never be opened in production.
  if (!isDev) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools()
    })
  }

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
    mainWindow.loadURL(devUrl)
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

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
    }
  })
}

app.whenReady().then(async () => {
  // Manual DevTools toggle in dev only (production is hard-disabled).
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (!mainWindow) return
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools()
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' })
      }
    })
  }

  // Set macOS Dock icon as early as possible after app is ready.
  ensureAppIcons()

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
    ensureAppIcons()
    updateTrayMenu()
  })
})

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed - tray keeps the app alive
  // On macOS this is already the default behavior
})

app.on('before-quit', async () => {
  isQuitting = true
  globalShortcut.unregisterAll()
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
