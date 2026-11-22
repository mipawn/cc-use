import { useEffect, useState } from 'react'
import { Alert, Button, Card, Input, Segmented, Space, Switch, Typography } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CliConfig } from '@shared/types'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAppMessage } from '../../hooks/useAppMessage'
import TerminalToolsPanel from '../providers/TerminalToolsPanel'

const { Text } = Typography
const { TextArea } = Input

const STRUCTURED_KEYS = [
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'API_TIMEOUT_MS',
] as const

function isTruthyEnv(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === '') return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return defaultValue
}

export default function ClaudeGlobalPrefsPanel() {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { globalSettings, fetchGlobalSettings, updateGlobalSettings } = useSettingsStore()

  const [mode, setMode] = useState<'structured' | 'json'>('structured')
  const [model, setModel] = useState('')
  const [gatewayDiscovery, setGatewayDiscovery] = useState(false)
  const [alwaysEnableEffort, setAlwaysEnableEffort] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState('')
  const [extraKeys, setExtraKeys] = useState<Record<string, unknown>>({})
  const [rawJson, setRawJson] = useState('{}')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetchGlobalSettings()
  }, [fetchGlobalSettings])

  const syncFromConfig = (source: CliConfig | undefined) => {
    const cfg: Record<string, unknown> = { ...(source ?? {}) }
    delete cfg.prelaunchCommand
    setModel(typeof cfg.ANTHROPIC_MODEL === 'string' ? cfg.ANTHROPIC_MODEL : '')
    setGatewayDiscovery(isTruthyEnv(cfg.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, true))
    setAlwaysEnableEffort(isTruthyEnv(cfg.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, true))
    setTimeoutMs(
      cfg.API_TIMEOUT_MS !== undefined && cfg.API_TIMEOUT_MS !== null
        ? String(cfg.API_TIMEOUT_MS)
        : '',
    )
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(cfg)) {
      if (!(STRUCTURED_KEYS as readonly string[]).includes(k)) {
        rest[k] = v
      }
    }
    setExtraKeys(rest)
    setRawJson(JSON.stringify(cfg, null, 2))
    setJsonError(null)
  }

  useEffect(() => {
    syncFromConfig(globalSettings.claudeConfig)
  }, [globalSettings.claudeConfig])

  const buildMergedConfig = (): CliConfig => {
    const next: Record<string, unknown> = { ...extraKeys }
    if (model.trim()) next.ANTHROPIC_MODEL = model.trim()
    // Backend defaults both flags to '1' when absent; write '0' explicitly when disabled.
    if (!gatewayDiscovery) next.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '0'
    if (!alwaysEnableEffort) next.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '0'
    if (timeoutMs.trim()) next.API_TIMEOUT_MS = timeoutMs.trim()
    delete next.prelaunchCommand
    return next as CliConfig
  }

  const handleModeSwitch = (nextMode: 'structured' | 'json') => {
    if (nextMode === 'json') {
      setRawJson(JSON.stringify(buildMergedConfig(), null, 2))
      setJsonError(null)
      setMode('json')
    } else {
      try {
        const parsed: unknown = JSON.parse(rawJson || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setJsonError(t('clients.globalPrefsInvalidJson'))
          return
        }
        syncFromConfig(parsed as CliConfig)
        setMode('structured')
      } catch {
        setJsonError(t('clients.globalPrefsInvalidJson'))
      }
    }
  }

  const handleSave = async () => {
    let payload: CliConfig
    if (mode === 'json') {
      try {
        const parsed: unknown = JSON.parse(rawJson || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setJsonError(t('clients.globalPrefsInvalidJson'))
          return
        }
        const copy = { ...(parsed as Record<string, unknown>) }
        delete copy.prelaunchCommand
        payload = copy as CliConfig
      } catch {
        setJsonError(t('clients.globalPrefsInvalidJson'))
        return
      }
    } else {
      payload = buildMergedConfig()
    }

    setSaving(true)
    setJsonError(null)
    try {
      await updateGlobalSettings({ claudeConfig: payload })
      message.success(t('clients.globalPrefsSaved'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title={t('clients.globalPrefsTitle')}
        extra={
          <Segmented
            size='small'
            value={mode}
            options={[
              { value: 'structured', label: t('clients.globalPrefsStructured') },
              { value: 'json', label: t('clients.globalPrefsJson') },
            ]}
            onChange={(val) => handleModeSwitch(val as 'structured' | 'json')}
          />
        }
      >
        {jsonError && (
          <Alert type='error' showIcon title={jsonError} style={{ marginBottom: 12 }} />
        )}

        {mode === 'structured' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Text strong style={{ fontSize: 13 }}>
                {t('clients.globalPrefsModel')}
              </Text>
              <Input
                value={model}
                placeholder='claude-sonnet-5'
                allowClear
                onChange={(e) => setModel(e.target.value)}
              />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Text strong style={{ fontSize: 13 }}>
                {t('clients.globalPrefsGatewayDiscovery')}
              </Text>
              <Switch checked={gatewayDiscovery} onChange={setGatewayDiscovery} />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Text strong style={{ fontSize: 13 }}>
                {t('clients.globalPrefsEffort')}
              </Text>
              <Switch checked={alwaysEnableEffort} onChange={setAlwaysEnableEffort} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Text strong style={{ fontSize: 13 }}>
                {t('clients.globalPrefsTimeout')}
              </Text>
              <Input
                value={timeoutMs}
                placeholder={t('clients.globalPrefsTimeoutPlaceholder')}
                allowClear
                style={{ maxWidth: 260 }}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <TextArea
              value={rawJson}
              onChange={(e) => {
                setRawJson(e.target.value)
                if (jsonError) setJsonError(null)
              }}
              autoSize={{ minRows: 8, maxRows: 18 }}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
            />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Space>
            <Button
              type='primary'
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void handleSave()}
            >
              {t('common.save')}
            </Button>
          </Space>
        </div>
      </Card>

      <TerminalToolsPanel />
    </div>
  )
}
