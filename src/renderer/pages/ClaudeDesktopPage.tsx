import { useEffect, useState } from 'react'
import { Typography, Button, message } from 'antd'
import { DesktopOutlined, ReloadOutlined } from '@ant-design/icons'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import TakeoverConfigTab, { type TakeoverStatus } from '../components/launchpad/TakeoverConfigTab'
import ConfigPreviewButton from '../components/launchpad/ConfigPreviewButton'

const { Title, Text } = Typography

export default function ClaudeDesktopPage() {
  const [, setLoading] = useState(true)
  const [status, setStatus] = useState<TakeoverStatus>('unknown')
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
      const s: string = await invoke('claude_desktop_schema_detect')
      switch (s) {
        case 'taken_over':
          setStatus('taken_over')
          try {
            const keyId: string | null = await invoke('get_setting', {
              key: 'claude_desktop_last_api_key_id',
            })
            if (keyId) setSelectedKeyId(keyId)
          } catch {
            /* ignore */
          }
          break
        case 'official':
          setStatus('official')
          break
        case 'not_found':
          setStatus('not_found')
          break
        default:
          setStatus('error')
          break
      }
    } catch {
      setStatus('error')
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
      const result: string = await invoke('claude_desktop_config_takeover', {
        providerId: key.providerId,
        apiKeyId: keyId,
      })
      message.success(result)
      setStatus('taken_over')
      setSelectedKeyId(keyId)
      await invoke('set_setting', { key: 'claude_desktop_last_api_key_id', value: keyId })
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
      const result: string = await invoke('claude_desktop_config_restore')
      message.success(result)
      setStatus('official')
      setSelectedKeyId('')
      await invoke('delete_setting', { key: 'claude_desktop_last_api_key_id' })
    } catch (e) {
      message.error(`恢复失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const allKeys = getAllApiKeys()

  return (
    <div className='page-container'>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <DesktopOutlined style={{ marginRight: 8 }} />
            Claude Desktop
          </Title>
          <Text type='secondary'>配置级接管 — 选择密钥接管 Claude Desktop 配置</Text>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <ConfigPreviewButton clientKind='claude_desktop' />
          {status === 'taken_over' && (
            <Button danger icon={<ReloadOutlined />} onClick={handleRestore} size='small'>
              恢复官方
            </Button>
          )}
        </div>
      </div>
      <div className='page-content' style={{ overflowY: 'auto' }}>
        <TakeoverConfigTab
          status={status}
          providers={providers}
          allKeys={allKeys}
          activeKeyId={selectedKeyId}
          targetClientKind='claude_desktop'
          onTakeover={handleTakeover}
          onReorderProviders={reorderProviders}
          onReorderApiKeys={reorderApiKeys}
        />
      </div>
    </div>
  )
}
