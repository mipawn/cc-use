// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProviderIcon from './ProviderIcon'

const read = vi.fn()
vi.mock('../../api', () => ({ getApi: () => ({ icon: { read } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  read.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('shares a library read between icon instances and accepts legacy paths', async () => {
  read.mockResolvedValue('data:image/png;base64,aWNvbg==')
  await act(async () =>
    root.render(
      <>
        <ProviderIcon icon='/old/library/shared.png' name='first' />
        <ProviderIcon icon='shared.png' name='second' />
      </>,
    ),
  )
  expect(read).toHaveBeenCalledExactlyOnceWith('shared.png')
  expect([...container.querySelectorAll('img')].map((img) => img.src)).toEqual([
    'data:image/png;base64,aWNvbg==',
    'data:image/png;base64,aWNvbg==',
  ])
})

it('shows a meaningful fallback for missing and undecodable files', async () => {
  read.mockRejectedValueOnce(new Error('missing'))
  await act(async () => root.render(<ProviderIcon icon='missing.png' />))
  expect(container.querySelector('[aria-label="providers.iconLoadFailed"]')).not.toBeNull()
  read.mockResolvedValueOnce('data:image/png;base64,broken')
  await act(async () => root.render(<ProviderIcon icon='broken.png' />))
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('[aria-label="providers.iconLoadFailed"]')).not.toBeNull()
})

it('does not let a late upload read replace a newly selected built-in mark', async () => {
  let resolve!: (source: string) => void
  read.mockReturnValue(
    new Promise<string>((done) => {
      resolve = done
    }),
  )
  await act(async () => root.render(<ProviderIcon icon='slow.png' />))
  await act(async () => root.render(<ProviderIcon icon='claude' />))
  const builtin = container.querySelector('img')!.src
  await act(async () => resolve('data:image/png;base64,old'))
  expect(container.querySelector('img')!.src).toBe(builtin)
})
