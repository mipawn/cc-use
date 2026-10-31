import { getApi } from '../api'
import { providerIconFilename } from './providerIcon'

// Uploaded names are immutable UUIDs. A deleted filename stays retired for the
// WebView lifetime so late reads/list responses cannot resurrect the resource.
const sources = new Map<string, Promise<string>>()
const deleted = new Set<string>()
const listeners = new Set<() => void>()
let revision = 0

export function isUploadedIconDeleted(icon: string): boolean {
  const filename = providerIconFilename(icon)
  return filename !== null && deleted.has(filename)
}

export function readUploadedIcon(filename: string): Promise<string> {
  if (deleted.has(filename)) return Promise.reject(new Error('Icon deleted'))
  let pending = sources.get(filename)
  if (!pending) {
    pending = getApi()
      .icon.read(filename)
      .then((data) => {
        if (deleted.has(filename)) throw new Error('Icon deleted')
        return data
      })
    sources.set(filename, pending)
    pending.catch(() => {
      if (sources.get(filename) === pending) sources.delete(filename)
    })
  }
  return pending
}

export function invalidateUploadedIcon(filename: string): void {
  deleted.add(filename)
  sources.delete(filename)
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeUploadedIcons(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getUploadedIconsRevision(): number {
  return revision
}
