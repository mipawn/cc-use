// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'

// The assertions target the rendered structure, not the translated copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

async function renderAt(path: string): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>,
    )
  })
  return container
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function linkTo(element: HTMLElement, href: string): HTMLAnchorElement | null {
  return element.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
}

function groupFor(element: HTMLElement, label: string): HTMLElement {
  const labelElement = [...element.querySelectorAll('span')].find(
    (candidate) => candidate.textContent === label,
  )
  expect(labelElement).toBeDefined()
  return labelElement!.parentElement as HTMLElement
}

describe('Sidebar navigation groups', () => {
  it('keeps gateway outside the management and observation groups', async () => {
    const rendered = await renderAt('/keys')

    const manageGroup = groupFor(rendered, 'workspace.manage')
    expect(linkTo(manageGroup, '/keys')).not.toBeNull()
    expect(linkTo(manageGroup, '/gateway')).toBeNull()

    const observationGroup = groupFor(rendered, 'workspace.observation')
    expect(linkTo(observationGroup, '/stats')).not.toBeNull()
    expect(linkTo(observationGroup, '/console')).not.toBeNull()
    expect(linkTo(observationGroup, '/gateway')).toBeNull()

    // The gateway entry has its own parent with exactly one link, so it is a
    // standalone access-point item rather than a member of either group.
    const gatewayLink = linkTo(rendered, '/gateway')
    expect(gatewayLink).not.toBeNull()
    expect(gatewayLink!.parentElement).not.toBe(manageGroup)
    expect(gatewayLink!.parentElement).not.toBe(observationGroup)
    expect(gatewayLink!.parentElement!.querySelectorAll('a')).toHaveLength(1)
  })

  it('marks only the current route as the active page', async () => {
    const rendered = await renderAt('/gateway')

    expect(linkTo(rendered, '/gateway')?.getAttribute('aria-current')).toBe('page')
    expect(linkTo(rendered, '/keys')?.hasAttribute('aria-current')).toBe(false)
    expect(linkTo(rendered, '/stats')?.hasAttribute('aria-current')).toBe(false)
    expect(linkTo(rendered, '/console')?.hasAttribute('aria-current')).toBe(false)
    expect(linkTo(rendered, '/')?.hasAttribute('aria-current')).toBe(false)
  })

  it('keeps the observation routes reachable through their own entries', async () => {
    const rendered = await renderAt('/console')

    expect(linkTo(rendered, '/console')?.getAttribute('aria-current')).toBe('page')
    expect(linkTo(rendered, '/stats')?.hasAttribute('aria-current')).toBe(false)
    expect(linkTo(rendered, '/gateway')?.hasAttribute('aria-current')).toBe(false)
  })

  it('highlights the console uniquely and keeps the gateway as one ordinary navigation row', async () => {
    const rendered = await renderAt('/console')
    expect(rendered.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(linkTo(rendered, '/console')?.getAttribute('aria-current')).toBe('page')
    expect(linkTo(rendered, '/logs')).toBeNull()
    const gateway = linkTo(rendered, '/gateway')!
    const keys = linkTo(rendered, '/keys')!
    expect(gateway.className).toBe(keys.className)
    expect(gateway.parentElement?.children).toHaveLength(1)
  })
})
