// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientCatalog, ClientModelConfig } from '../../utils/modelMapping'
import type { ModelEditorActions } from './ModelEditorView'
import ModelCatalogManager, { type ModelCatalogDraft } from './ModelCatalogManager'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('./ModelHelp', () => ({ default: () => null }))
vi.mock('./ModelViewHeader', () => ({ default: () => null }))
vi.mock('../UserAgentField', () => ({ default: () => null }))

const emptyClient = (): ClientModelConfig => ({
  catalogMode: 'custom',
  models: [],
  roles: { sonnet: '', opus: '', haiku: '', fable: '' },
  defaultModel: '',
  forwardMode: 'follow',
  upstreamModel: '',
  haiku: '',
  sonnet: '',
  opus: '',
})
const catalog: ClientCatalog = {
  models: [
    { id: 'model-a', displayName: '' },
    { id: 'model-b', displayName: '' },
  ],
  fromCache: false,
  fetchedAt: '2026-10-28T00:00:00Z',
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
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

interface RenderOptions {
  value?: Partial<ClientModelConfig>
  draft?: ModelCatalogDraft
  catalog?: ClientCatalog
}

async function renderManager(options: RenderOptions = {}) {
  const onCommit = vi.fn()
  const onBack = vi.fn()
  const onLoad = vi.fn()
  await act(async () =>
    root.render(
      <ModelCatalogManager
        label='Claude Code'
        value={{ ...emptyClient(), ...options.value }}
        initialDraft={options.draft}
        catalog={options.catalog}
        onCommit={onCommit}
        onBack={onBack}
        onActionsChange={(next) => {
          actions = next
        }}
      />,
    ),
  )
  return { onCommit, onBack, onLoad }
}

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)

async function click(text: string) {
  const target = button(text)
  expect(target).toBeDefined()
  await act(async () => target!.click())
}

async function setInput(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(selector)
  expect(field).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function confirm() {
  await act(async () => actions?.confirm?.())
}

async function back() {
  await act(async () => actions?.back?.())
}

const row = (id: string) => container.querySelector(`[data-model-row="${id}"]`)

it('uses saved provider choices without a query or User-Agent control', async () => {
  await renderManager({ catalog })
  expect(container.textContent).toContain('keys.savedCatalogHint')
  expect(container.textContent).not.toContain('keys.catalogLoad')
  expect(container.querySelector('[aria-label="User-Agent"]')).toBeNull()
})

it('does not preselect fetched candidates in custom mode', async () => {
  await renderManager({ catalog })
  for (const model of ['model-a', 'model-b']) {
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${model}"]`)?.checked).toBe(
      false,
    )
  }
})

it('commits only the model the user checked', async () => {
  const { onCommit } = await renderManager({ catalog })

  await act(async () =>
    container.querySelector<HTMLInputElement>('input[aria-label="model-a"]')!.click(),
  )
  await confirm()

  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'custom',
    models: [{ id: 'model-a', displayName: 'model-a' }],
  })
})

it('fetching candidates never commits or adds models by itself', async () => {
  const { onCommit, onBack } = await renderManager({ catalog })
  expect(onCommit).not.toHaveBeenCalled()

  await back()
  expect(onBack).toHaveBeenCalledTimes(1)
  const draft = onBack.mock.calls[0][0] as ModelCatalogDraft
  expect(draft.models).toEqual([])
  expect(onBack.mock.calls[0][1]).toBe(false)
})

it('keeps saved models that are missing from the current catalog', async () => {
  const { onCommit } = await renderManager({
    value: { catalogMode: 'custom', models: [{ id: 'saved-model', displayName: 'Saved' }] },
    catalog,
  })

  expect(row('saved-model')).not.toBeNull()
  expect(container.textContent).toContain('keys.savedCatalogHint')

  await confirm()
  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'custom',
    models: [{ id: 'saved-model', displayName: 'Saved' }],
  })
})

it('shows an explicit empty answer and still allows manual models', async () => {
  const { onCommit } = await renderManager({
    value: { catalogMode: 'custom', models: [] },
    catalog: { models: [], fromCache: false, fetchedAt: '' },
  })
  expect(container.textContent).toContain('keys.noMatchingModels')

  await click('keys.manualAddModel')
  await setInput('input[aria-label="keys.clientModelId"]', 'manual-model')
  await setInput('input[aria-label="keys.clientModelName"]', 'Manual label')
  await click('keys.clientModelAdd')
  await confirm()

  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'custom',
    models: [{ id: 'manual-model', displayName: 'Manual label' }],
  })
})

it('validates a manual model id and dedupes configured ids', async () => {
  await renderManager({ catalog, value: { catalogMode: 'custom' } })
  await click('keys.manualAddModel')

  await setInput('input[aria-label="keys.clientModelId"]', '')
  await click('keys.clientModelAdd')
  expect(container.textContent).toContain('keys.clientModelIdRequired')

  await setInput('input[aria-label="keys.clientModelId"]', 'https://example.com/v1')
  await click('keys.clientModelAdd')
  expect(container.textContent).toContain('keys.clientModelIdRequired')

  await setInput('input[aria-label="keys.clientModelId"]', 'model with space')
  await click('keys.clientModelAdd')
  expect(container.textContent).toContain('keys.clientModelIdRequired')

  // Adding a provider-supplied ID creates one configured row, not a duplicate.
  await setInput('input[aria-label="keys.clientModelId"]', 'model-a')
  await click('keys.clientModelAdd')
  expect(container.querySelectorAll('[data-model-row="model-a"]')).toHaveLength(1)
  // Adding the same id again is rejected rather than duplicated.
  await click('keys.manualAddModel')
  await setInput('input[aria-label="keys.clientModelId"]', 'model-a')
  await click('keys.clientModelAdd')
  expect(container.textContent).toContain('keys.clientModelDuplicate')
  expect(container.querySelectorAll('[data-model-row="model-a"]')).toHaveLength(1)
})

it('filters to selected models only', async () => {
  await renderManager({
    catalog,
    value: { catalogMode: 'custom', models: [{ id: 'model-a', displayName: '' }] },
  })
  expect(row('model-b')).not.toBeNull()

  await act(async () =>
    container.querySelector<HTMLInputElement>('input[aria-label="keys.selectedOnly"]')!.click(),
  )

  expect(row('model-a')).not.toBeNull()
  expect(row('model-b')).toBeNull()
})

it('keeps an explicit append strategy and its additions', async () => {
  const { onCommit } = await renderManager({
    value: { catalogMode: 'append', models: [{ id: 'added-model', displayName: 'Added' }] },
    catalog,
  })

  await confirm()
  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'append',
    models: [{ id: 'added-model', displayName: 'Added' }],
  })
})

it('allows selection under provider strategy without silently changing it', async () => {
  const { onCommit } = await renderManager({ value: { catalogMode: 'provider' }, catalog })
  expect((button('keys.manualAddModel') as HTMLButtonElement).disabled).toBe(false)
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[aria-label="model-a"]')!.click(),
  )
  await confirm()
  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'provider',
    models: [{ id: 'model-a', displayName: 'model-a' }],
  })
})

it('adds a cloud candidate to an append list as a draft addition', async () => {
  const { onCommit } = await renderManager({
    value: { catalogMode: 'append', models: [] },
    catalog,
  })

  await act(async () =>
    container.querySelector<HTMLInputElement>('input[aria-label="model-b"]')!.click(),
  )
  await confirm()

  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'append',
    models: [{ id: 'model-b', displayName: 'model-b' }],
  })
})

it('bulk-selects only current search results and keeps existing selections', async () => {
  const { onCommit } = await renderManager({
    catalog,
    value: { models: [{ id: 'saved-model', displayName: 'Saved' }] },
  })
  await setInput('input[aria-label="keys.searchModels"]', 'model-b')
  await click('keys.selectAllModels')
  await confirm()
  expect(onCommit).toHaveBeenCalledWith({
    catalogMode: 'custom',
    models: [
      { id: 'saved-model', displayName: 'Saved' },
      { id: 'model-b', displayName: 'model-b' },
    ],
  })
})
