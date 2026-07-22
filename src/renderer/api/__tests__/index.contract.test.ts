import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

async function loadApiModule() {
  vi.resetModules()
  return import('../index')
}

describe('renderer api contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caches the api instance', async () => {
    const { getApi } = await loadApiModule()

    const first = getApi()
    const second = getApi()

    expect(first).toBe(second)
  })

  it('maps representative invoke commands and arguments correctly', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { getApi } = await loadApiModule()
    const api = getApi()

    await api.provider.get('provider-1')
    await api.provider.create({ name: 'Provider', baseUrl: 'https://example.com' } as never)
    await api.terminal.getLaunchPreview({ cliType: 'claude', projectId: 'project-1' })
    await api.proxy.restart()
    await api.settings.get()

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'provider_get', { id: 'provider-1' })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'provider_create', {
      input: { name: 'Provider', baseUrl: 'https://example.com' },
    })
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'terminal_get_launch_preview', {
      cliType: 'claude',
      projectId: 'project-1',
    })
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'proxy_restart', undefined)
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'settings_get', undefined)
  })

  it('converts ArrayBuffer payloads for icon upload', async () => {
    invokeMock.mockResolvedValue('uploaded-icon.png')
    const { getApi } = await loadApiModule()
    const api = getApi()
    const buffer = Uint8Array.from([1, 2, 255]).buffer

    await api.icon.upload(buffer, 'icon.png')

    expect(invokeMock).toHaveBeenCalledWith('icon_upload', {
      buffer: [1, 2, 255],
      filename: 'icon.png',
    })
  })

  it('passes the CLI type when creating a manual proxy session', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { getApi } = await loadApiModule()

    await getApi().session.create('provider-1', 'key-1', 'grok')

    expect(invokeMock).toHaveBeenCalledWith('session_create', {
      providerId: 'provider-1',
      apiKeyId: 'key-1',
      cliType: 'grok',
    })
  })

  it('maps managed instance commands and arguments correctly', async () => {
    invokeMock.mockResolvedValue(undefined)
    const { getApi } = await loadApiModule()
    const api = getApi() as any

    await api.managedInstances.list()
    await api.managedInstances.get('instance-1')
    await api.managedInstances.updateAssignment({
      id: 'instance-1',
      providerId: 'provider-1',
      apiKeyId: 'key-1',
      assignmentSource: 'manual_ui',
    })
    await api.managedInstances.cleanup('grok')

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'managed_instance_list', undefined)
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'managed_instance_get', { id: 'instance-1' })
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'managed_instance_update_assignment', {
      input: {
        id: 'instance-1',
        providerId: 'provider-1',
        apiKeyId: 'key-1',
        assignmentSource: 'manual_ui',
      },
    })
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'managed_instance_cleanup', {
      cliType: 'grok',
    })
  })

  it('subscribes to proxy status events and disposes the listener', async () => {
    const unlistenMock = vi.fn()
    let eventHandler:
      | ((event: { payload: { isRunning: boolean; port: number; source?: string } }) => void)
      | undefined
    listenMock.mockImplementation(async (_event, handler) => {
      eventHandler = handler
      return unlistenMock
    })

    const { getApi } = await loadApiModule()
    const api = getApi()
    const callback = vi.fn()

    const dispose = api.proxy.onStatusChanged(callback)
    await vi.dynamicImportSettled()

    eventHandler?.({ payload: { isRunning: true, port: 12345, source: 'test' } })
    dispose()

    expect(listenMock).toHaveBeenCalledWith('proxy:statusChanged', expect.any(Function))
    expect(callback).toHaveBeenCalledWith({ isRunning: true, port: 12345, source: 'test' })
    expect(unlistenMock).toHaveBeenCalledTimes(1)
  })
})
