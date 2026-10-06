#!/usr/bin/env node
// Standalone sidecar preparation. Normal dev/build uses cargo-build.mjs so
// the app, daemon and CLI share one Cargo invocation and feature set.
import process from 'node:process'
import { buildBinaries, hostTriple, stageSidecars } from './cargo-build.mjs'

function readFlag(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

const profile =
  readFlag('profile') || (process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release')
if (!['debug', 'release'].includes(profile)) {
  throw new Error(`Unknown profile=${profile}, expected release|debug`)
}
const host = hostTriple()
const target = readFlag('target') || process.env.TAURI_ENV_TARGET_TRIPLE || host
const args = []
if (profile === 'release') args.push('--release')
if (target !== host || readFlag('target')) args.push('--target', target)

const { artifacts, code } = await buildBinaries(args, ['cc-use-daemon', 'cc-use-cli'])
if (code !== 0) process.exit(code)
stageSidecars(artifacts, target)
