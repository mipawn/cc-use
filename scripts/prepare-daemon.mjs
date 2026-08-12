#!/usr/bin/env node
// Stage the cc-use-daemon binary for Tauri bundling.
//
// Tauri's externalBin resolves binaries from
//   src-tauri/binaries/<name>-<target-triple>(.ext)
// and copies them into the app bundle at `Contents/MacOS/<name>` (the
// target-triple suffix is stripped on macOS/Linux). Without this step
// the release bundle ships no daemon at all — prod installs fall back
// to hunting the workspace target dir, which only works on developer
// machines.
//
// This script is invoked from tauri.conf.json's beforeDev/beforeBuild
// hooks, so Tauri has already set the target-triple and profile in the
// environment by the time we run:
//   TAURI_ENV_TARGET_TRIPLE  e.g. aarch64-apple-darwin / x86_64-apple-darwin
//   TAURI_ENV_DEBUG          "true" for dev / --debug builds, else "false"
// Explicit CLI flags still win when someone runs the script by hand:
//   node scripts/prepare-daemon.mjs --profile=release --target=aarch64-apple-darwin

import { execSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = dirname(scriptDir)

function readFlag(name) {
  const prefix = `--${name}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : undefined
}

const profile =
  readFlag('profile') || (process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release')
if (profile !== 'release' && profile !== 'debug') {
  console.error(`prepare-daemon: unknown profile=${profile}, expected release|debug`)
  process.exit(1)
}

const hostTriple = (() => {
  const rustcVersion = execSync('rustc -vV', { encoding: 'utf8' })
  return rustcVersion
    .split('\n')
    .find((line) => line.startsWith('host:'))
    ?.split(':')[1]
    ?.trim()
})()

if (!hostTriple) {
  console.error('prepare-daemon: could not determine host target triple from rustc -vV')
  process.exit(1)
}

const targetTriple = readFlag('target') || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple

// v3.7.0: the CLI ships in the bundle alongside the daemon and gets the
// same externalBin staging treatment.
const binaries = [
  { crate: 'cc-use-daemon', name: 'cc-use-daemon' },
  { crate: 'cc-use-cli', name: 'cc-use-cli' },
]

const destDir = join(workspaceRoot, 'src-tauri', 'binaries')

// Circular-dependency workaround: tauri-build (a build script of the
// cc-use crate) validates externalBin entries up front and aborts if
// any staged binary is missing. But both crates depend on cc-use-lib,
// so a fresh cargo build would need to compile cc-use first — before
// the binaries it wants to stage even exist. Zero-byte placeholders
// satisfy the existence check; we overwrite them once cargo succeeds.
mkdirSync(destDir, { recursive: true })
for (const { name } of binaries) {
  const placeholder = join(destDir, `${name}-${targetTriple}`)
  if (!existsSync(placeholder)) {
    writeFileSync(placeholder, '')
    chmodSync(placeholder, 0o755)
    console.log(`prepare-daemon: wrote empty placeholder at ${placeholder}`)
  }
}

const isCrossBuild = targetTriple !== hostTriple
const sourceDir = isCrossBuild
  ? join(workspaceRoot, 'target', targetTriple, profile)
  : join(workspaceRoot, 'target', profile)

function latestMtime(path) {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  return readdirSync(path, { withFileTypes: true }).reduce(
    (latest, entry) => Math.max(latest, latestMtime(join(path, entry.name))),
    stat.mtimeMs,
  )
}

// A clean dev start must not invoke Cargo twice. The sidecars depend on the
// shared Rust library, whose Tauri build-script environment differs between a
// standalone cargo build and `tauri dev`; alternating the two commands makes
// Cargo rebuild the same crate on every launch. Source mtimes give dev mode a
// deterministic fast path while release builds continue to rebuild normally.
if (profile === 'debug' && !isCrossBuild) {
  const sourceInputs = [
    join(workspaceRoot, 'Cargo.toml'),
    join(workspaceRoot, 'Cargo.lock'),
    join(workspaceRoot, 'src-tauri', 'Cargo.toml'),
    join(workspaceRoot, 'src-tauri', 'build.rs'),
    join(workspaceRoot, 'src-tauri', 'src'),
    join(workspaceRoot, 'crates', 'cc-use-daemon', 'Cargo.toml'),
    join(workspaceRoot, 'crates', 'cc-use-daemon', 'src'),
    join(workspaceRoot, 'crates', 'cc-use-cli', 'Cargo.toml'),
    join(workspaceRoot, 'crates', 'cc-use-cli', 'src'),
  ]
  const newestSource = Math.max(...sourceInputs.map(latestMtime))
  const debugBinaries = binaries.map(({ name }) => join(sourceDir, name))
  const sidecarsAreCurrent = debugBinaries.every(
    (path) => existsSync(path) && statSync(path).size > 0 && statSync(path).mtimeMs >= newestSource,
  )
  if (sidecarsAreCurrent) {
    console.log('prepare-daemon: debug sidecars are current; skipped Cargo build')
    process.exit(0)
  }
}

const cargoArgs = ['cargo', 'build']
for (const { crate } of binaries) {
  cargoArgs.push('-p', crate)
}
if (profile === 'release') cargoArgs.push('--release')
if (isCrossBuild) {
  cargoArgs.push('--target', targetTriple)
}

console.log(
  `prepare-daemon: ${cargoArgs.join(' ')}  (profile=${profile}, target=${targetTriple}${isCrossBuild ? ', cross' : ''})`,
)
execSync(cargoArgs.join(' '), { stdio: 'inherit', cwd: workspaceRoot })

// cargo lays out artifacts as target/<triple>/<profile>/<name> when
// --target is passed, and target/<profile>/<name> otherwise. Keep the
// non-cross path because daemon_client.rs' debug branch looks at
// target/debug/cc-use-daemon — passing --target there would move the
// binary somewhere the app can't find it.
for (const { name } of binaries) {
  const sourcePath = join(sourceDir, name)
  if (!existsSync(sourcePath)) {
    console.error(`prepare-daemon: cargo finished but binary missing at ${sourcePath}`)
    process.exit(1)
  }
  if (profile === 'debug' && !isCrossBuild) {
    console.log(`prepare-daemon: ready ${sourcePath} (dev uses target/debug directly)`)
    continue
  }
  const destPath = join(destDir, `${name}-${targetTriple}`)
  const sourceStat = statSync(sourcePath)
  const destinationStat = existsSync(destPath) ? statSync(destPath) : null
  const alreadyStaged =
    destinationStat &&
    destinationStat.size === sourceStat.size &&
    destinationStat.mtimeMs >= sourceStat.mtimeMs
  if (!alreadyStaged) copyFileSync(sourcePath, destPath)
  const { size } = statSync(destPath)
  console.log(
    `prepare-daemon: ${alreadyStaged ? 'unchanged' : 'staged'} ${destPath} (${size.toLocaleString()} bytes)`,
  )
}
