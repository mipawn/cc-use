import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildArgs, stageSidecars } from './cargo-build.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 120; i++) {
    if (check()) return
    await wait(25)
  }
  assert.fail('Timed out waiting for subprocess')
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-use-cargo-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'tools'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  copyFileSync(join(scriptsDir, 'cargo-build.mjs'), join(root, 'scripts/cargo-build.mjs'))
  const cargo = join(root, 'tools/cargo')
  writeFileSync(
    cargo,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.FIXTURE_ROOT
const args = process.argv.slice(2)
writeFileSync(join(root, 'invocation.json'), JSON.stringify({args, config: process.env.TAURI_CONFIG}))
if (args.includes('--fail')) { console.error('could not compile fixture'); process.exit(101) }
if (args.includes('--hang')) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"])
  writeFileSync(join(root, 'pids.json'), JSON.stringify({cargo: process.pid, child: child.pid, supervisor: process.ppid}))
  setInterval(()=>{},1000)
} else {
  for (const name of ['cc-use','cc-use-daemon','cc-use-cli']) {
    const executable = join(root, name)
    writeFileSync(executable, name === 'cc-use' ? '#!/usr/bin/env node\\nimport { writeFileSync } from "node:fs";writeFileSync(process.env.FIXTURE_ROOT+"/app.json",JSON.stringify(process.argv.slice(2)))\\n' : name)
    if (name === 'cc-use') chmodSync(executable, 0o755)
    console.log(JSON.stringify({reason:'compiler-artifact',target:{name,kind:['bin']},executable}))
  }
}
`,
  )
  chmodSync(cargo, 0o755)
  return {
    root,
    runner: join(root, 'scripts/cargo-build.mjs'),
    env: {
      ...process.env,
      FIXTURE_ROOT: root,
      PATH: `${join(root, 'tools')}:${process.env.PATH}`,
      TAURI_CONFIG: '{"identifier":"com.mipawn.cc-use.dev"}',
    },
  }
}
function launch(f, args) {
  const child = spawn(process.execPath, [f.runner, ...args], {
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stderr.on('data', (data) => {
    output += data
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, output }))
  })
  return { child, done }
}

test('one build selects all binaries and retains target/profile/features', () => {
  const args = buildArgs([
    '--bins',
    '--bin',
    'cc-use',
    '--release',
    '--target',
    'x86_64-apple-darwin',
    '--features',
    'tauri/custom-protocol',
    '--no-default-features',
  ])
  assert.equal(args.filter((arg) => arg === 'build').length, 1)
  assert.equal(args.filter((arg) => arg === '--bins').length, 1)
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === '-p'),
    ['cc-use', 'cc-use-daemon', 'cc-use-cli'],
  )
  assert.ok(
    args.includes('--release') &&
      args.includes('x86_64-apple-darwin') &&
      args.includes('tauri/custom-protocol') &&
      args.includes('--no-default-features'),
  )
})

test('staging replaces same-size newer stale files, then preserves unchanged mtimes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cc-use-stage-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dest = join(root, 'binaries')
  mkdirSync(dest)
  const artifacts = new Map()
  for (const name of ['cc-use-daemon', 'cc-use-cli']) {
    const source = join(root, name)
    writeFileSync(source, 'NEW')
    artifacts.set(name, source)
    writeFileSync(join(dest, `${name}-aarch64-apple-darwin`), 'OLD')
  }
  stageSidecars(artifacts, 'aarch64-apple-darwin', dest)
  const staged = join(dest, 'cc-use-daemon-aarch64-apple-darwin')
  assert.equal(readFileSync(staged, 'utf8'), 'NEW')
  assert.ok(statSync(staged).mode & 0o100)
  const before = statSync(staged).mtimeMs
  stageSidecars(artifacts, 'aarch64-apple-darwin', dest)
  assert.equal(statSync(staged).mtimeMs, before)
})

test('real runner builds once, stages the selected architecture, and keeps Tauri overrides', async (t) => {
  const f = fixture(t)
  const result = await launch(f, [
    'build',
    '--release',
    '--target=x86_64-apple-darwin',
    '--features',
    'tauri/custom-protocol',
  ]).done
  assert.equal(result.code, 0, result.output)
  const invocation = JSON.parse(readFileSync(join(f.root, 'invocation.json')))
  assert.equal(invocation.config, f.env.TAURI_CONFIG)
  assert.equal(invocation.args[0], 'build')
  assert.equal(
    readFileSync(join(f.root, 'src-tauri/binaries/cc-use-daemon-x86_64-apple-darwin'), 'utf8'),
    'cc-use-daemon',
  )
  assert.equal(existsSync(join(f.root, 'app.json')), false)
})

test('dev runner forwards app arguments and does not stage sidecars', async (t) => {
  const f = fixture(t)
  const result = await launch(f, ['run', '--no-default-features', '--', '--example', 'a value'])
    .done
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'app.json'))), ['--example', 'a value'])
  assert.equal(existsSync(join(f.root, 'src-tauri/binaries')), false)
  assert.ok(!JSON.parse(readFileSync(join(f.root, 'invocation.json'))).args.includes('--example'))
})

test('Cargo failure propagates without launching or staging', async (t) => {
  const f = fixture(t)
  const result = await launch(f, ['build', '--fail']).done
  assert.equal(result.code, 101, result.output)
  assert.equal(existsSync(join(f.root, 'src-tauri/binaries')), false)
  assert.equal(existsSync(join(f.root, 'app.json')), false)
})

test('killing the runner also stops Cargo and descendants that ignore SIGTERM', async (t) => {
  const f = fixture(t)
  const { child, done } = launch(f, ['run', '--hang'])
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {}
  })
  await until(() => existsSync(join(f.root, 'pids.json')))
  const pids = JSON.parse(readFileSync(join(f.root, 'pids.json')))
  t.after(() => {
    for (const pid of Object.values(pids)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  })
  child.kill('SIGKILL')
  await done
  await until(() => Object.values(pids).every((pid) => !alive(pid)))
})
