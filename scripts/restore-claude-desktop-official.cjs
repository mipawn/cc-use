#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')

const CC_USE_PROFILE_ID = '00000000-0000-4000-8000-000000157210'

const home = os.homedir()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const appSupport = path.join(home, 'Library', 'Application Support')
const backupDir = path.join(appSupport, 'Claude-cc-use-backups', stamp)

const normalConfigPath = path.join(appSupport, 'Claude', 'claude_desktop_config.json')
const threepConfigPath = path.join(appSupport, 'Claude-3p', 'claude_desktop_config.json')
const metaPath = path.join(appSupport, 'Claude-3p', 'configLibrary', '_meta.json')
const ccUseProfilePath = path.join(
  appSupport,
  'Claude-3p',
  'configLibrary',
  `${CC_USE_PROFILE_ID}.json`,
)

function readJson(file) {
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function backup(file) {
  if (!fs.existsSync(file)) return
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(file, path.join(backupDir, path.basename(file)))
}

for (const file of [normalConfigPath, threepConfigPath, metaPath, ccUseProfilePath]) {
  backup(file)
}

for (const file of [normalConfigPath, threepConfigPath]) {
  const config = readJson(file)
  config.deploymentMode = '1p'
  writeJson(file, config)
}

const meta = readJson(metaPath)
meta.entries = (Array.isArray(meta.entries) ? meta.entries : []).filter(
  (entry) => entry && entry.id !== CC_USE_PROFILE_ID,
)

if (meta.appliedId === CC_USE_PROFILE_ID) {
  if (meta.entries[0] && meta.entries[0].id) {
    meta.appliedId = meta.entries[0].id
  } else {
    delete meta.appliedId
  }
}

writeJson(metaPath, meta)

if (fs.existsSync(ccUseProfilePath)) {
  fs.renameSync(ccUseProfilePath, `${ccUseProfilePath}.disabled-${stamp}`)
}

console.log('Claude Desktop has been restored to official mode.')
console.log(`Backup directory: ${backupDir}`)
