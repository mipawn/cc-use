#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export function normalizeVersion(version) {
  const normalized = version.trim().replace(/^v/, '')
  if (!normalized) throw new Error('Release version must not be empty')
  return normalized
}

export function extractReleaseNotes(changelog, version) {
  const normalizedVersion = normalizeVersion(version)
  const headingPattern = /^## \[([^\]]+)\](?:\s+-\s+.+)?\s*$/gm
  const headings = [...changelog.matchAll(headingPattern)]
  const matches = headings.filter((heading) => heading[1] === normalizedVersion)

  if (matches.length === 0) {
    throw new Error(`Changelog section for version ${normalizedVersion} was not found`)
  }
  if (matches.length > 1) {
    throw new Error(`Changelog section for version ${normalizedVersion} appears more than once`)
  }

  const match = matches[0]
  const sectionStart = match.index + match[0].length
  const nextHeading = headings.find((heading) => heading.index > match.index)
  const sectionEnd = nextHeading?.index ?? changelog.length
  const notes = changelog.slice(sectionStart, sectionEnd).trim()

  if (!notes) {
    throw new Error(`Changelog section for version ${normalizedVersion} is empty`)
  }

  return notes
}

function parseArguments(argv) {
  const args = {}

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${name ?? '(end of input)'}`)
    }
    args[name.slice(2)] = value
  }

  return args
}

function writeGitHubOutput(outputPath, notes) {
  const delimiter = `CC_USE_RELEASE_NOTES_${randomUUID()}`
  appendFileSync(outputPath, `body<<${delimiter}\n${notes}\n${delimiter}\n`)
}

export function run(argv) {
  const args = parseArguments(argv)
  if (!args.version) throw new Error('Missing required --version argument')

  const changelogPath = args.changelog || 'CHANGELOG.md'
  const changelog = readFileSync(changelogPath, 'utf8')
  const notes = extractReleaseNotes(changelog, args.version)

  if (args['github-output']) {
    writeGitHubOutput(args['github-output'], notes)
  } else {
    process.stdout.write(`${notes}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Failed to extract release notes: ${message}\n`)
    process.exitCode = 1
  }
}
