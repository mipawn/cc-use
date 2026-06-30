import { useEffect, useState } from 'react'
import { Typography, Button, message } from 'antd'
import { AppstoreOutlined, ReloadOutlined } from '@ant-design/icons'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import TakeoverConfigTab, { type TakeoverStatus } from '../components/launchpad/TakeoverConfigTab'
import ConfigPreviewButton from '../components/launchpad/ConfigPreviewButton'

const { Title, Text } = Typography

export default function CodexPage() {
  const [, setLoading] = useState(true)
  const [takenOver, setTakenOver] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState<string>('')

  const { providers, fetchProviders, reorderProviders } = useProviderStore()
  const { getAllApiKeys, fetchAllApiKeys, reorderApiKeys } = useApiKeyStore()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])
  useEffect(() => {
    if (providers.length > 0) fetchAllApiKeys(providers.map((p) => p.id))
  }, [providers, fetchAllApiKeys])

  const checkStatus = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const taken: boolean = await invoke('codex_config_is_taken_over')
      setTakenOver(taken)
      if (taken) {
        try {
          const keyId: string | null = await invoke('get_setting', { key: 'codex_last_api_key_id' })
          if (keyId) setSelectedKeyId(keyId)
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.error('Status check failed:', e)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    checkStatus()
  }, [])

  const handleTakeover = async (keyId: string) => {
    const key = allKeys.find((k) => k.id === keyId)
    if (!key) return
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('codex_config_takeover', {
        providerId: key.providerId,
        apiKeyId: keyId,
      })
      message.success(result)
      setTakenOver(true)
      setSelectedKeyId(keyId)
      await invoke('set_setting', { key: 'codex_last_api_key_id', value: keyId })
    } catch (e) {
      message.error(`接管失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('codex_config_restore')
      message.success(result)
      setTakenOver(false)
      setSelectedKeyId('')
      await invoke('delete_setting', { key: 'codex_last_api_key_id' })
    } catch (e) {
      message.error(`恢复失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const allKeys = getAllApiKeys()
  const takeoverStatus: TakeoverStatus = takenOver ? 'taken_over' : 'official'

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <AppstoreOutlined style={{ marginRight: 8 }} />
            Codex Desktop
          </Title>
          <Text type='secondary'>配置级接管 — 选择密钥接管 ~/.codex/config.toml</Text>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ConfigPreviewButton clientKind='codex' />
          {takenOver && (
            <Button danger icon={<ReloadOutlined />} onClick={handleRestore} size='small'>
              恢复官方
            </Button>
          )}
        </div>
      </div>
      <div className='page-content' style={{ overflowY: 'auto' }}>
        <TakeoverConfigTab
          status={takeoverStatus}
          providers={providers}
          allKeys={allKeys}
          activeKeyId={selectedKeyId}
          targetClientKind='codex'
          onTakeover={handleTakeover}
          onReorderProviders={reorderProviders}
          onReorderApiKeys={reorderApiKeys}
        />
      </div>
    </div>
  )
}
