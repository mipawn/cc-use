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

import { execSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(scriptDir);

function readFlag(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const profile =
  readFlag('profile') ||
  (process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release');
if (profile !== 'release' && profile !== 'debug') {
  console.error(`prepare-daemon: unknown profile=${profile}, expected release|debug`);
  process.exit(1);
}

const hostTriple = (() => {
  const rustcVersion = execSync('rustc -vV', { encoding: 'utf8' });
  return rustcVersion
    .split('\n')
    .find((line) => line.startsWith('host:'))
    ?.split(':')[1]
    ?.trim();
})();

if (!hostTriple) {
  console.error('prepare-daemon: could not determine host target triple from rustc -vV');
  process.exit(1);
}

const targetTriple =
  readFlag('target') || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple;

// v3.7.0: the CLI ships in the bundle alongside the daemon and gets the
// same externalBin staging treatment.
const binaries = [
  { crate: 'cc-use-daemon', name: 'cc-use-daemon' },
  { crate: 'cc-use-cli', name: 'cc-use-cli' },
];

const destDir = join(workspaceRoot, 'src-tauri', 'binaries');

// Circular-dependency workaround: tauri-build (a build script of the
// cc-use crate) validates externalBin entries up front and aborts if
// any staged binary is missing. But both crates depend on cc-use-lib,
// so a fresh cargo build would need to compile cc-use first — before
// the binaries it wants to stage even exist. Zero-byte placeholders
// satisfy the existence check; we overwrite them once cargo succeeds.
mkdirSync(destDir, { recursive: true });
for (const { name } of binaries) {
  const placeholder = join(destDir, `${name}-${targetTriple}`);
  if (!existsSync(placeholder)) {
    writeFileSync(placeholder, '');
    chmodSync(placeholder, 0o755);
    console.log(`prepare-daemon: wrote empty placeholder at ${placeholder}`);
  }
}

const isCrossBuild = targetTriple !== hostTriple;
const cargoArgs = ['cargo', 'build'];
for (const { crate } of binaries) {
  cargoArgs.push('-p', crate);
}
if (profile === 'release') cargoArgs.push('--release');
if (isCrossBuild) {
  cargoArgs.push('--target', targetTriple);
}

console.log(
  `prepare-daemon: ${cargoArgs.join(' ')}  (profile=${profile}, target=${targetTriple}${isCrossBuild ? ', cross' : ''})`
);
execSync(cargoArgs.join(' '), { stdio: 'inherit', cwd: workspaceRoot });

// cargo lays out artifacts as target/<triple>/<profile>/<name> when
// --target is passed, and target/<profile>/<name> otherwise. Keep the
// non-cross path because daemon_client.rs' debug branch looks at
// target/debug/cc-use-daemon — passing --target there would move the
// binary somewhere the app can't find it.
const sourceDir = isCrossBuild
  ? join(workspaceRoot, 'target', targetTriple, profile)
  : join(workspaceRoot, 'target', profile);

for (const { name } of binaries) {
  const sourcePath = join(sourceDir, name);
  if (!existsSync(sourcePath)) {
    console.error(`prepare-daemon: cargo finished but binary missing at ${sourcePath}`);
    process.exit(1);
  }
  const destPath = join(destDir, `${name}-${targetTriple}`);
  copyFileSync(sourcePath, destPath);
  const { size } = statSync(destPath);
  console.log(`prepare-daemon: staged ${destPath} (${size.toLocaleString()} bytes)`);
}
