#!/usr/bin/env node
/**
 * Tauri development frontend runner.
 *
 * Tauri executes beforeDevCommand through a shell. The config uses `exec` so
 * this process replaces that shell and remains a direct child of Tauri. When
 * Tauri exits unexpectedly, the parent PID changes to 1 and the watchdog closes
 * Vite instead of leaving port 5173 occupied by an orphan process.
 */
import process from 'node:process'
import { createServer } from 'vite'

const tauriPid = process.ppid

let viteServer = null
let shuttingDown = false

function isTauriAlive() {
  if (process.ppid === 1) return false
  try {
    process.kill(tauriPid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(parentWatchdog)

  if (viteServer) {
    await viteServer.close()
  }
  process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void shutdown(0)
  })
}

const parentWatchdog = setInterval(() => {
  if (!isTauriAlive()) {
    console.log('dev-server: Tauri parent exited; closing Vite')
    void shutdown(0)
  }
}, 1_000)

async function main() {
  viteServer = await createServer({
    clearScreen: false,
  })
  await viteServer.listen()
  viteServer.printUrls()
}

main().catch((error) => {
  console.error('dev-server: failed to start')
  console.error(error)
  void shutdown(1)
})
