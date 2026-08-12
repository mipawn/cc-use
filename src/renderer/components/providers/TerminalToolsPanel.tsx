/**
 * Claude Code 状态栏设置 (v3.7.0)
 *
 * statusLine 写入的是 app 内二进制的绝对路径，不依赖 PATH，
 * 所以不安装命令行工具也能启用状态栏。
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, Typography, Space, Button, Tag, Modal } from 'antd'
import { DesktopOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import { useAppMessage } from '../../hooks/useAppMessage'
import type { StatuslineState } from '@shared/types'
import styles from './TerminalToolsPanel.module.css'

const { Paragraph } = Typography

export default function TerminalToolsPanel() {
  const { t } = useTranslation()
  const message = useAppMessage()

  const [statusline, setStatusline] = useState<StatuslineState | null>(null)
  const [statuslineBusy, setStatuslineBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await getApi().cliTool.statuslineStatus()
      setStatusline(next)
      return next
    } catch (error) {
      setStatusline(null)
      throw error
    }
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  const confirmThirdPartyOverwrite = (command: string) => {
    Modal.confirm({
      title: t('terminalTools.statuslineConflictTitle'),
      content: t('terminalTools.statuslineConflictBody', { command }),
      okText: t('terminalTools.statuslineOverwrite'),
      cancelText: t('terminalTools.statuslineKeepExisting'),
      autoFocusButton: 'cancel',
      onOk: () => enableStatusline(true),
    })
  }

  const enableStatusline = async (force: boolean) => {
    setStatuslineBusy(true)
    try {
      const result = await getApi().cliTool.statuslineEnable(force)
      if (result.enabled) {
        const verified = await refresh()
        if (verified.state === 'enabled' && verified.current) {
          message.success(t('terminalTools.statuslineEnabled'))
        } else {
          message.error(t('terminalTools.statuslineEnableNotApplied'))
        }
      } else if (result.blockedBy) {
        confirmThirdPartyOverwrite(result.blockedBy)
      }
    } catch (error) {
      message.error(String(error))
    } finally {
      setStatuslineBusy(false)
    }
  }

  const restoreStatusline = async () => {
    setStatuslineBusy(true)
    try {
      await getApi().cliTool.statuslineRestore()
      await refresh()
      message.success(t('terminalTools.statuslineRestored'))
    } catch (error) {
      message.error(String(error))
    } finally {
      setStatuslineBusy(false)
    }
  }

  const statuslineTag = (() => {
    if (!statusline) return null
    switch (statusline.state) {
      case 'enabled':
        return statusline.current ? (
          <Tag color='green'>{t('terminalTools.stateEnabled')}</Tag>
        ) : (
          <Tag color='orange'>{t('terminalTools.stateStale')}</Tag>
        )
      case 'thirdParty':
        return <Tag color='default'>{t('terminalTools.stateThirdParty')}</Tag>
      default:
        return <Tag color='default'>{t('terminalTools.stateNotConfigured')}</Tag>
    }
  })()

  const statuslineEnabled = statusline?.state === 'enabled'
  const requestEnableStatusline = () => {
    if (statusline?.state === 'thirdParty') {
      confirmThirdPartyOverwrite(statusline.command)
      return
    }
    void enableStatusline(false)
  }

  return (
    <div style={{ padding: 16, maxWidth: 860 }}>
      {/* statusLine */}
      <Card
        variant='outlined'
        style={{ marginBottom: 16 }}
        title={
          <Space>
            <DesktopOutlined />
            <span>{t('terminalTools.statuslineTitle')}</span>
            {statuslineTag}
          </Space>
        }
        extra={
          <Space>
            {statuslineEnabled ? (
              <>
                {statusline.state === 'enabled' && !statusline.current && (
                  <Button
                    size='small'
                    type='primary'
                    loading={statuslineBusy}
                    onClick={() => void enableStatusline(true)}
                  >
                    {t('terminalTools.statuslineUpdate')}
                  </Button>
                )}
                <Button
                  size='small'
                  loading={statuslineBusy}
                  onClick={() => void restoreStatusline()}
                >
                  {t('terminalTools.statuslineDisable')}
                </Button>
              </>
            ) : (
              <Button
                size='small'
                type='primary'
                loading={statuslineBusy}
                onClick={requestEnableStatusline}
              >
                {statusline?.state === 'thirdParty'
                  ? t('terminalTools.statuslineOverwriteAndEnable')
                  : t('terminalTools.statuslineEnable')}
              </Button>
            )}
          </Space>
        }
      >
        <Paragraph type='secondary' style={{ marginBottom: 8 }}>
          {t('terminalTools.statuslineDesc')}
        </Paragraph>
        <div
          className={styles.hudPreview}
          role='img'
          aria-label={t('terminalTools.statuslineDesc')}
        >
          <div className={styles.hudLine}>
            <span className={styles.hudBrand}>CC USE</span>
            <span className={styles.hudDivider}>│</span>
            <span className={styles.hudProvider}>Anthropic</span>
            <span className={styles.hudSlash}>/</span>
            <span className={styles.hudKey}>Work Key</span>
            <span className={styles.hudDivider}>│</span>
            <span className={styles.hudInstance}>8f32ac91</span>
          </div>
          <div className={styles.hudLine}>
            <span className={styles.hudModel}>[Opus 4.1]</span>
            <span className={styles.hudDivider}>│</span>
            <span className={styles.hudGit}>
              git:(<span className={styles.hudGitBranch}>main*</span>)
            </span>
            <span className={styles.hudDivider}>│</span>
            <span className={styles.hudContextLabel}>Context</span>
            <span className={styles.hudContext}>████░░░░░░ 42%</span>
          </div>
        </div>
        {statusline?.state === 'thirdParty' && (
          <Paragraph type='secondary' style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
            {t('terminalTools.statuslineThirdPartyHint', { command: statusline.command })}
          </Paragraph>
        )}
        <Paragraph type='secondary' style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          {t('terminalTools.statuslineApplyHint')}
        </Paragraph>
      </Card>
    </div>
  )
}
