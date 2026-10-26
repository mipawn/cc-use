// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientCatalog, ClientModelConfig } from '../../utils/modelMapping'
import type { ModelEditorActions } from './ModelEditorView'
import ModelCatalogManager from './ModelCatalogManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('./ModelHelp', () => ({ default: () => null }))
vi.mock('./ModelViewHeader', () => ({ default: () => null }))
vi.mock('../UserAgentField', () => ({ default: () => null }))

const value: ClientModelConfig = {
  catalogMode: 'custom',
  models: [],
  roles: { sonnet: '', opus: '', haiku: '', fable: '' },
  defaultModel: '',
  forwardMode: 'follow',
  upstreamModel: '',
  haiku: '',
  sonnet: '',
  opus: '',
}
const catalog: ClientCatalog = {
  models: [
    { id: 'model-a', displayName: '' },
    { id: 'model-b', displayName: '' },
  ],
  fromCache: false,
  fetchedAt: '',
}

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
})

let container: HTMLDivElement
let root: Root
let actions: ModelEditorActions | null

beforeEach(() => {
  actions = null
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderManager(onCommit = vi.fn()) {
  await act(async () =>
    root.render(
      <ModelCatalogManager
        label='Claude Code'
        value={value}
        initialSource='custom'
        catalog={catalog}
        loading={false}
        canLoad
        onLoad={async () => {}}
        onCommit={onCommit}
        onBack={() => {}}
        userAgent=''
        userAgentReady
        onUserAgentChange={() => {}}
        onUserAgentApply={() => {}}
        onActionsChange={(next) => {
          actions = next
        }}
      />,
    ),
  )
  return onCommit
}

it('does not preselect fetched catalog models in custom mode', async () => {
  await renderManager()

  const modelA = container.querySelector<HTMLInputElement>('input[aria-label="model-a"]')
  const modelB = container.querySelector<HTMLInputElement>('input[aria-label="model-b"]')
  expect(modelA?.checked).toBe(false)
  expect(modelB?.checked).toBe(false)
})

it('commits only the model the user checked', async () => {
  const onCommit = await renderManager()

  const modelA = container.querySelector<HTMLInputElement>('input[aria-label="model-a"]')
  await act(async () => modelA?.click())
  await act(async () => actions?.confirm?.())

  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'custom',
    models: [{ id: 'model-a', displayName: '' }],
  })
})
