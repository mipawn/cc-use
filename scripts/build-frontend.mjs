#!/usr/bin/env node
// Tauri embeds these files with include_bytes!: rewriting identical Vite
// output invalidates the Rust library on every package build. Restore the
// timestamps only when the bytes are unchanged, keeping Cargo's cache valid.
import { existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const previous = new Map()
function snapshot(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) snapshot(path)
    else if (entry.isFile()) previous.set(path, { stat: statSync(path), bytes: readFileSync(path) })
  }
}
snapshot(join(workspaceRoot, 'dist'))
await build({ root: workspaceRoot })
let unchanged = 0
for (const [path, { stat, bytes }] of previous) {
  if (
    existsSync(path) &&
    statSync(path).size === bytes.length &&
    readFileSync(path).equals(bytes)
  ) {
    utimesSync(path, stat.atimeMs / 1000, stat.mtimeMs / 1000)
    unchanged++
  }
}
console.log(`build-frontend: preserved timestamps for ${unchanged} unchanged files`)
