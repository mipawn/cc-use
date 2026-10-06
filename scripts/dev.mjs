#!/usr/bin/env node
/**
 * Own the complete Tauri development process tree.
 *
 * Tauri's Cargo runner builds the app and sidecars together. Tauri runs in its
 * own process group, allowing one Ctrl+C to stop the complete dev process tree.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = dirname(scriptDir)
const tauriBin = join(workspaceRoot, 'node_modules', '.bin', 'tauri')

let activeProcess = null
let shuttingDown = false

function terminateProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function spawnOwned(command, args) {
  return spawn(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  terminateProcessGroup(activeProcess)
  await new Promise((resolve) => setTimeout(resolve, 400))
  terminateProcessGroup(activeProcess, 'SIGKILL')
  if (!shuttingDown) process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void shutdown(0)
  })
}

async function main() {
  console.log('dev: starting Tauri (Ctrl+C stops the complete dev process tree)')
  activeProcess = spawnOwned(tauriBin, ['dev', '--config', 'src-tauri/tauri.dev.conf.json'])
  const exitCode = await new Promise((resolve, reject) => {
    activeProcess.once('error', reject)
    activeProcess.once('exit', (code, signal) => {
      terminateProcessGroup(activeProcess)
      resolve(signal ? 1 : (code ?? 1))
    })
  })
  process.exit(exitCode)
}

main().catch((error) => {
  if (shuttingDown) return
  console.error('dev: failed to start')
  console.error(error)
  void shutdown(1)
})
