import { app, BrowserWindow, nativeImage } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { initDatabase, closeDatabase } from './database'
import { registerIpcHandlers } from './ipc/handlers'
import { startProxy, stopProxy } from './services/proxy'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow: BrowserWindow | null = null

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#141414',
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  initDatabase()
  registerIpcHandlers()

  // Start proxy server
  try {
    await startProxy()
    console.log('Proxy server started')
  } catch (error) {
    console.error('Failed to start proxy server:', error)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  await stopProxy()
  closeDatabase()
})
