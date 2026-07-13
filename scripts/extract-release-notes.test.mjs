import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractReleaseNotes } from './extract-release-notes.mjs'

const changelog = `# Changelog

## [3.3.1] - 2026-07-13

### Added

- Codex model mapping

### Changed

- Real release notes

## [3.3.0] - 2026-07-12

### Fixed

- Previous fix

## [3.2.7] - 2026-07-10

### Fixed

- Older fix
`

describe('extractReleaseNotes', () => {
  it('extracts the first version with all of its subsections', () => {
    assert.equal(
      extractReleaseNotes(changelog, '3.3.1'),
      `### Added

- Codex model mapping

### Changed

- Real release notes`,
    )
  })

  it('accepts a v-prefixed version and excludes adjacent versions', () => {
    assert.equal(extractReleaseNotes(changelog, 'v3.3.0'), `### Fixed\n\n- Previous fix`)
  })

  it('matches the complete version instead of a similar prefix', () => {
    assert.throws(() => extractReleaseNotes(changelog, '3.3'), /was not found/)
  })

  it('fails when the requested version is missing', () => {
    assert.throws(() => extractReleaseNotes(changelog, '4.0.0'), /was not found/)
  })

  it('fails when the requested version appears more than once', () => {
    const duplicate = `${changelog}\n## [3.3.1] - 2026-07-14\n\n- Duplicate\n`
    assert.throws(() => extractReleaseNotes(duplicate, '3.3.1'), /more than once/)
  })

  it('fails when the requested version has no content', () => {
    const empty = `# Changelog\n\n## [3.3.1] - 2026-07-13\n\n## [3.3.0] - 2026-07-12\n\n- Previous`
    assert.throws(() => extractReleaseNotes(empty, '3.3.1'), /is empty/)
  })
})
