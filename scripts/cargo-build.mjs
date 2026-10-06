#!/usr/bin/env node
// Tauri Cargo runner: compile all three binaries with the CLI's exact target,
// profile, features and environment, then run the app or stage its sidecars.
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const workspaceRoot = dirname(dirname(scriptPath))
const packages = ['cc-use', 'cc-use-daemon', 'cc-use-cli']
const sidecars = ['cc-use-daemon', 'cc-use-cli']

export function hostTriple() {
  const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((line) => line.startsWith('host: '))
    ?.slice(6)
    .trim()
  if (!triple) throw new Error('Could not determine the Rust host target')
  return triple
}

export function buildArgs(args, selectedPackages = packages) {
  const result = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bins') continue
    if (args[i] === '--bin') {
      if (args[++i] !== 'cc-use') throw new Error('The Tauri runner must run cc-use')
      continue
    }
    if (args[i] === '--bin=cc-use') continue
    if (args[i] === '--message-format') {
      i++
      continue
    }
    if (args[i].startsWith('--message-format=')) continue
    result.push(args[i])
  }
  return [
    'build',
    ...result,
    ...selectedPackages.flatMap((name) => ['-p', name]),
    '--bins',
    '--message-format=json-render-diagnostics',
  ]
}

// Tauri's Rust watcher kills its runner directly, including with SIGKILL.
// A small supervisor owns each child process group and watches the runner's
// parenthood, so a rebuild or Ctrl+C also closes Cargo/rustc/the desktop app.
export function spawnSupervised(command, args, stdout = 'inherit') {
  return spawn(process.execPath, [scriptPath, '--supervise', command, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['inherit', stdout, 'inherit'],
    detached: true,
  })
}

function supervise(command, args) {
  const parentPid = process.ppid
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    clearInterval(watchdog)
    process.kill(-process.pid, 'SIGTERM')
    setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 400)
  }
  const watchdog = setInterval(() => {
    // Node snapshots process.ppid at startup; probe the original PID instead
    // of relying on that property changing after the runner is killed.
    try {
      if (parentPid === 1) shutdown()
      else process.kill(parentPid, 0)
    } catch (error) {
      if (error.code !== 'EPERM') shutdown()
    }
  }, 250)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown)
  const child = spawn(command, args, { stdio: 'inherit', env: process.env })
  child.once('error', (error) => {
    console.error(error.message)
    shutdown()
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    clearInterval(watchdog)
    process.exit(code ?? (signal ? 1 : 0))
  })
}

function completion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

export async function buildBinaries(args, selectedPackages = packages) {
  const child = spawnSupervised('cargo', buildArgs(args, selectedPackages), 'pipe')
  const finished = completion(child)
  const artifacts = new Map()
  for await (const line of createInterface({ input: child.stdout })) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stdout.write(`${line}\n`)
      continue
    }
    if (
      message.reason === 'compiler-artifact' &&
      message.target.kind.includes('bin') &&
      message.executable
    ) {
      artifacts.set(message.target.name, message.executable)
    }
  }
  return { artifacts, code: await finished }
}

export function stageSidecars(
  artifacts,
  target,
  destDir = join(workspaceRoot, 'src-tauri', 'binaries'),
) {
  if (!/^[\w.-]+$/.test(target)) throw new Error(`Invalid target triple: ${target}`)
  mkdirSync(destDir, { recursive: true })
  for (const name of sidecars) {
    const source = artifacts.get(name)
    if (!source || !statSync(source).isFile() || statSync(source).size === 0) {
      throw new Error(`Cargo did not produce a valid ${name} binary`)
    }
    const destination = join(destDir, `${name}-${target}`)
    if (
      existsSync(destination) &&
      statSync(destination).size === statSync(source).size &&
      readFileSync(destination).equals(readFileSync(source))
    )
      continue
    const temporary = `${destination}.${process.pid}.tmp`
    copyFileSync(source, temporary)
    chmodSync(temporary, 0o755)
    renameSync(temporary, destination)
    console.error(`cargo-build: staged ${name} for ${target}`)
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === '--supervise') {
    supervise(args[0], args.slice(1))
    return
  }
  if (!['run', 'build'].includes(command)) throw new Error(`Unsupported Cargo command: ${command}`)
  const separator = args.indexOf('--')
  const cargoArgs = separator < 0 ? args : args.slice(0, separator)
  const appArgs = separator < 0 ? [] : args.slice(separator + 1)
  const started = performance.now()
  const { artifacts, code } = await buildBinaries(cargoArgs)
  if (code !== 0) process.exit(code)
  console.error(
    `cargo-build: app, daemon and CLI ready in ${((performance.now() - started) / 1000).toFixed(2)}s`,
  )
  if (command === 'build') {
    const targetArg = cargoArgs.find((arg) => arg.startsWith('--target='))?.slice(9)
    const targetIndex = cargoArgs.indexOf('--target')
    stageSidecars(
      artifacts,
      targetArg || (targetIndex < 0 ? hostTriple() : cargoArgs[targetIndex + 1]),
    )
  } else {
    const executable = artifacts.get('cc-use')
    if (!executable) throw new Error('Cargo did not produce the desktop application')
    const app = spawnSupervised(executable, appArgs)
    process.exit(await completion(app))
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`cargo-build: ${error.message}`)
    process.exit(1)
  })
}
