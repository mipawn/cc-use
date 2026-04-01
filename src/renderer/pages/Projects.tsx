import { getApi } from '../api'
/**
 * Projects - 项目管理页面（卡片布局）
 * 完整的增删改查 + 代理服务控制
 */
import { useEffect, useState } from 'react'
import {
  Typography,
  Button,
  theme,
  Card,
  Space,
  Modal,
  Form,
  Input,
  Switch,
  Tooltip,
  Popconfirm,
  Dropdown,
  Segmented,
  Badge,
  type MenuProps,
} from 'antd'
import { useAppMessage } from '../hooks/useAppMessage'
import {
  FolderOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  KeyOutlined,
  WarningOutlined,
  FolderAddOutlined,
  ClockCircleOutlined,
  SwapOutlined,
} from '@ant-design/icons'

// Import provider icons
import claudeIcon from '../assets/provider-icons/claude.svg'
import openaiIcon from '../assets/provider-icons/openai.svg'
import zhipuIcon from '../assets/provider-icons/zhipu.svg'
import minimaxIcon from '../assets/provider-icons/minimax.svg'
import deepseekIcon from '../assets/provider-icons/deepseek.svg'
import siliconflowIcon from '../assets/provider-icons/siliconflow.svg'
import newapiIcon from '../assets/provider-icons/newapi.svg'

import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../stores/projectStore'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import KeyCascader from '../components/common/KeyCascader'
import SimpleBar from 'simplebar-react'
import type { Project, ApiKey, ProviderType, Provider } from '@shared/types'
import styles from './Projects.module.css'

const { Title, Text } = Typography
const { TextArea } = Input

// Preset provider icon mapping
const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  zhipu: zhipuIcon,
  minimax: minimaxIcon,
  deepseek: deepseekIcon,
  siliconflow: siliconflowIcon,
  newapi: newapiIcon,
}

// Get provider icon src
function getProviderIconSrc(provider: Provider | null): string {
  if (!provider) {
    return PRESET_ICON_MAP.claude
  }
  if (!provider.icon) {
    return PRESET_ICON_MAP[provider.type ?? 'claude'] || PRESET_ICON_MAP.claude
  }
  if (PRESET_ICON_MAP[provider.icon]) {
    return PRESET_ICON_MAP[provider.icon]
  }
  return `file://${provider.icon}`
}

// CLI type icon component
const CliTypeIcon = ({ type, size = 14 }: { type: 'claude' | 'codex'; size?: number }) => {
  const icon = type === 'claude' ? claudeIcon : openaiIcon
  return <img src={icon} alt={type} style={{ width: size, height: size }} />
}

export default function Projects() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const message = useAppMessage()
  const { projects, fetchProjects, createProject, updateProject, deleteProject } = useProjectStore()
  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys, getAllApiKeys, apiKeys: apiKeysByProvider } = useApiKeyStore()

  const allApiKeys = getAllApiKeys()

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [form] = Form.useForm()

  // Proxy state
  const [proxyRunning, setProxyRunning] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)

  useEffect(() => {
    fetchProjects()
    fetchProviders()
    checkProxyStatus()

    const unsubscribe = getApi().proxy.onStatusChanged((data) => {
      setProxyRunning(data.isRunning)
      if (data.source === 'tray') {
        if (data.isRunning) {
          message.success(t('projects.proxyStarted'))
        } else {
          message.info(t('projects.proxyStopped'))
        }
      }
    })
    return () => {
      unsubscribe()
    }
  }, [fetchProjects, fetchProviders])

  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map((p) => p.id))
    }
  }, [providers, fetchAllApiKeys])

  // Check proxy status
  const checkProxyStatus = async () => {
    try {
      const status = await getApi().proxy.status()
      setProxyRunning(status.isRunning)
    } catch (error) {
      console.error('Failed to check proxy status:', error)
    }
  }

  // Toggle proxy
  const handleProxyToggle = async (checked: boolean) => {
    if (proxyLoading) return

    // If turning off, show confirmation
    if (!checked) {
      Modal.confirm({
        title: t('settings.proxyStopConfirm') || '确认关闭代理？',
        content: t('settings.proxyStopWarning') || '关闭后，无法记录使用量',
        okText: t('common.confirm') || '确认',
        cancelText: t('common.cancel') || '取消',
        onOk: async () => {
          setProxyLoading(true)
          try {
            await getApi().proxy.stop()
            setProxyRunning(false)
            message.success(t('projects.proxyStopped'))
          } catch (error) {
            message.error(t('projects.proxyError'))
          } finally {
            setProxyLoading(false)
          }
        },
      })
      return
    }

    // Turn on proxy
    setProxyLoading(true)
    try {
      await getApi().proxy.start()
      setProxyRunning(true)
      message.success(t('projects.proxyStarted'))
    } catch (error) {
      message.error(t('projects.proxyError'))
    } finally {
      setProxyLoading(false)
    }
  }

  const getProvider = (providerId: string | null) => {
    if (!providerId) return null
    return providers.find((p) => p.id === providerId) || null
  }

  const getApiKey = (apiKeyId: string | null): ApiKey | null => {
    if (!apiKeyId) return null
    return allApiKeys.find((k) => k.id === apiKeyId) || null
  }

  const getKeyAlias = (key: ApiKey | null) => {
    if (!key) return null
    return key.alias || `Key ${key.priority + 1}`
  }

  // Check if the key supports the project's CLI type
  const isKeyCompatible = (project: Project, apiKey: ApiKey | null): boolean => {
    if (!apiKey) return false
    return apiKey.types.includes(project.cliType || 'claude')
  }

  const formatDate = (timestamp: string | null) => {
    if (!timestamp) return t('common.never')
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const days = Math.floor(hours / 24)

    if (hours < 1) return t('common.justNow')
    if (hours < 24) return `${hours} ${t('common.hoursAgo')}`
    if (days < 7) return `${days} ${t('common.daysAgo')}`
    return date.toLocaleDateString()
  }

  // Open project
  const handleOpen = async (project: Project) => {
    if (!project.providerId || !project.apiKeyId) {
      message.warning(t('projects.configureFirst'))
      handleEdit(project)
      return
    }

    const apiKey = getApiKey(project.apiKeyId)
    if (!isKeyCompatible(project, apiKey)) {
      message.warning(t('projects.keyNotCompatible'))
      return
    }

    if (!proxyRunning) {
      message.warning(t('projects.proxyNotRunning'))
      return
    }

    try {
      await getApi().terminal.launch(project.id)
      message.success(`${t('projects.opened')} ${project.name}`)
      fetchProjects()
    } catch (error) {
      message.error(t('projects.openFailed'))
    }
  }

  // Add new project
  const handleAdd = () => {
    setEditingProject(null)
    form.resetFields()
    setModalOpen(true)
  }

  // Edit project
  const handleEdit = (project: Project) => {
    setEditingProject(project)
    form.setFieldsValue({
      name: project.name,
      path: project.path,
      remark: project.remark,
      key: project.providerId && project.apiKeyId ? [project.providerId, project.apiKeyId] : null,
      cliType: project.cliType || 'claude',
    })
    setModalOpen(true)
  }

  // Quick switch CLI type for a project
  const handleSwitchCliType = async (project: Project, cliType: ProviderType) => {
    try {
      await updateProject({
        id: project.id,
        cliType,
      })
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  // Quick switch key for a project
  const handleSwitchKey = async (project: Project, providerId: string, keyId: string) => {
    try {
      await updateProject({
        id: project.id,
        providerId,
        apiKeyId: keyId,
      })
      // Also update any active proxy session for this project
      // so usage stats are recorded against the new key
      await getApi().session.updateByProject(project.id, providerId, keyId)
      message.success(t('projects.keySwitched'))
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  // Build key switch menu items for a project
  const getKeySwitchMenuItems = (project: Project): NonNullable<MenuProps['items']> => {
    const items: NonNullable<MenuProps['items']> = []

    providers.forEach((provider) => {
      const providerKeys = apiKeysByProvider[provider.id] || []
      if (providerKeys.length === 0) return

      if (items.length > 0) {
        items.push({
          type: 'divider',
          key: `divider-${provider.id}`,
        })
      }

      items.push({
        type: 'group',
        key: `group-${provider.id}`,
        label: (
          <div className={styles.keySwitchGroupLabel}>
            <div className={styles.keySwitchGroupTitle}>
              <img
                src={getProviderIconSrc(provider)}
                alt={provider.name}
                className={styles.keySwitchGroupIcon}
              />
              <span className={styles.keySwitchGroupName}>{provider.name}</span>
            </div>
            <span className={styles.keySwitchGroupCount}>{providerKeys.length}</span>
          </div>
        ),
        children: providerKeys.map((key) => {
          const isCurrent = project.apiKeyId === key.id

          return {
            key: `${provider.id}:${key.id}`,
            label: (
              <div className={styles.keySwitchMenuItemContent}>
                <span
                  className={`${styles.keySwitchMenuItemName} ${isCurrent ? styles.keySwitchMenuItemNameCurrent : ''}`}
                >
                  {key.alias || `Key ${key.priority + 1}`}
                </span>
                <div className={styles.keySwitchMenuItemMeta}>
                  <Space size={2} className={styles.keySwitchMenuItemTypes}>
                    {key.types.map((type) => (
                      <CliTypeIcon key={type} type={type} size={12} />
                    ))}
                  </Space>
                  {isCurrent && (
                    <Badge
                      status='success'
                      text={t('common.current')}
                      className={styles.keySwitchCurrentBadge}
                    />
                  )}
                </div>
              </div>
            ),
            className: isCurrent ? styles.keySwitchMenuItemCurrent : undefined,
            disabled: isCurrent,
            onClick: () => handleSwitchKey(project, provider.id, key.id),
          }
        }),
      })
    })

    return items
  }

  // Save project
  const handleSave = async () => {
    try {
      const values = await form.validateFields()

      if (editingProject) {
        // Update existing project
        const providerId = values.key?.[0] || null
        const apiKeyId = values.key?.[1] || null
        await updateProject({
          id: editingProject.id,
          name: values.name,
          remark: values.remark,
          providerId,
          apiKeyId,
          cliType: values.cliType as ProviderType,
        })
        // Sync active proxy session so usage stats track the new key
        if (providerId && apiKeyId) {
          await getApi().session.updateByProject(editingProject.id, providerId, apiKeyId)
        }
        message.success(t('projects.projectUpdated'))
      } else {
        // Create new project
        await createProject({
          name: values.name,
          path: values.path,
          remark: values.remark,
          providerId: values.key?.[0],
          apiKeyId: values.key?.[1],
          cliType: values.cliType as ProviderType,
        })
        message.success(t('projects.projectCreated'))
      }

      setModalOpen(false)
      setEditingProject(null)
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message)
      }
    }
  }

  // Delete project
  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id)
      message.success(t('projects.projectDeleted'))
    } catch (error) {
      message.error(t('projects.deleteProjectFailed'))
    }
  }

  // Select folder
  const handleSelectFolder = async () => {
    try {
      const path = await getApi().system.selectFolder()
      if (path) {
        form.setFieldValue('path', path)
        // Auto-fill name from folder name
        const folderName = path.split('/').pop() || path.split('\\').pop()
        if (folderName && !form.getFieldValue('name')) {
          form.setFieldValue('name', folderName)
        }
      }
    } catch (error) {
      message.error(t('projects.selectFolderFailed'))
    }
  }

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div>
          <Title level={3} className='!m-0 !mb-1'>
            {t('projects.title')}
          </Title>
          <Text type='secondary'>{t('projects.subtitle')}</Text>
        </div>
        <Space size='middle' align='center'>
          {/* Proxy Status */}
          <Tooltip title={proxyRunning ? t('projects.proxyRunning') : t('projects.proxyStopped')}>
            <div
              className={styles.proxyStatus}
              style={{
                background: proxyRunning ? token.colorSuccessBg : token.colorBgContainerDisabled,
                borderColor: proxyRunning ? token.colorSuccessBorder : token.colorBorder,
              }}
            >
              <span
                className={styles.proxyDot}
                style={{
                  background: proxyRunning ? token.colorSuccess : token.colorTextQuaternary,
                }}
              />
              <Text style={{ fontSize: 12 }}>{t('projects.proxy')}</Text>
              <Switch
                checked={proxyRunning}
                onChange={handleProxyToggle}
                loading={proxyLoading}
                size='small'
              />
            </div>
          </Tooltip>
          <Button type='primary' icon={<PlusOutlined />} onClick={handleAdd}>
            {t('projects.addProject')}
          </Button>
        </Space>
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {projects.length === 0 ? (
            <Card className='empty-state' variant='outlined'>
              <FolderOutlined
                className='text-5xl mb-4'
                style={{ color: token.colorTextSecondary }}
              />
              <Title level={4} className='!mb-2'>
                {t('projects.noProjects')}
              </Title>
              <Text type='secondary' className='block mb-4'>
                {t('projects.dropFolderHint')}
              </Text>
              <Button type='primary' icon={<PlusOutlined />} onClick={handleAdd}>
                {t('projects.addProject')}
              </Button>
            </Card>
          ) : (
            <div className={styles.projectsGrid}>
              {projects.map((project) => {
                const provider = getProvider(project.providerId)
                const apiKey = getApiKey(project.apiKeyId)
                const hasKey = !!project.providerId && !!project.apiKeyId
                const cliType = project.cliType || 'claude'
                const keyCompatible = isKeyCompatible(project, apiKey)
                const canOpen = hasKey && keyCompatible

                return (
                  <Card key={project.id} className={styles.projectCard} variant='outlined'>
                    {/* Card Header */}
                    <div className={styles.projectCardHeader}>
                      <Text strong className={styles.projectName}>
                        {project.name}
                      </Text>
                      {/* CLI Type Dropdown */}
                      <Dropdown
                        menu={{
                          items: [
                            {
                              key: 'claude',
                              label: (
                                <Space size={6}>
                                  <CliTypeIcon type='claude' size={14} />
                                  <span>Claude Code</span>
                                </Space>
                              ),
                              onClick: () => handleSwitchCliType(project, 'claude'),
                            },
                            {
                              key: 'codex',
                              label: (
                                <Space size={6}>
                                  <CliTypeIcon type='codex' size={14} />
                                  <span>Codex CLI</span>
                                </Space>
                              ),
                              onClick: () => handleSwitchCliType(project, 'codex'),
                            },
                          ],
                          selectedKeys: [cliType],
                        }}
                        trigger={['click']}
                        placement='bottomRight'
                      >
                        <Button type='text' size='small' className={styles.cliTypeButton}>
                          <CliTypeIcon type={cliType} size={14} />
                        </Button>
                      </Dropdown>
                    </div>

                    {/* Remark */}
                    {project.remark && (
                      <Text type='secondary' className={styles.projectRemark}>
                        {t('projects.remark')}：{project.remark}
                      </Text>
                    )}

                    {/* Key Binding Section */}
                    <div className={styles.keyBinding}>
                      {hasKey ? (
                        <div className={styles.keyBindingContent}>
                          <div className={styles.keyBindingInfo}>
                            <img
                              src={getProviderIconSrc(provider)}
                              alt={provider?.name}
                              className={styles.providerIcon}
                            />
                            <Text className={styles.providerName}>{provider?.name}</Text>
                            <Text type='secondary' className={styles.keyName}>
                              / {getKeyAlias(apiKey)}
                            </Text>
                            <Space size={2} style={{ marginLeft: 4 }}>
                              {apiKey?.types.map((type) => (
                                <CliTypeIcon key={type} type={type} size={12} />
                              ))}
                            </Space>
                          </div>
                          <Dropdown
                            classNames={{ root: styles.keySwitchDropdown }}
                            menu={{
                              items: getKeySwitchMenuItems(project),
                              classNames: {
                                root: styles.keySwitchMenu,
                              },
                              styles: {
                                root: { maxHeight: 320, overflow: 'auto' },
                              },
                            }}
                            trigger={['click']}
                            placement='bottomRight'
                          >
                            <Button type='text' size='small' icon={<SwapOutlined />} />
                          </Dropdown>
                        </div>
                      ) : (
                        <div className={styles.noKeyBinding}>
                          <WarningOutlined style={{ color: token.colorWarning, fontSize: 14 }} />
                          <Text type='secondary' style={{ fontSize: 12 }}>
                            {t('projects.noKeyBound')}
                          </Text>
                          <Button type='link' size='small' onClick={() => handleEdit(project)}>
                            {t('projects.configureNow')}
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Incompatible Warning */}
                    {hasKey && !keyCompatible && (
                      <div className={styles.incompatibleWarning}>
                        <WarningOutlined />
                        <Text type='warning' style={{ fontSize: 11 }}>
                          {t('projects.keyNotCompatibleHint')}
                        </Text>
                      </div>
                    )}

                    {/* Card Footer */}
                    <div className={styles.projectFooter}>
                      <Text type='secondary' className={styles.projectTime}>
                        <ClockCircleOutlined style={{ marginRight: 4 }} />
                        {formatDate(project.lastOpenedAt)}
                      </Text>
                      <Space size={4}>
                        <Tooltip title={t('common.edit')}>
                          <Button
                            type='text'
                            size='small'
                            icon={<EditOutlined />}
                            onClick={() => handleEdit(project)}
                          />
                        </Tooltip>
                        <Popconfirm
                          title={t('projects.deleteProject')}
                          description={t('projects.deleteProjectHint')}
                          onConfirm={() => handleDelete(project.id)}
                          okText={t('common.delete')}
                          cancelText={t('common.cancel')}
                          okButtonProps={{ danger: true }}
                        >
                          <Tooltip title={t('common.delete')}>
                            <Button type='text' size='small' danger icon={<DeleteOutlined />} />
                          </Tooltip>
                        </Popconfirm>
                        <Button
                          type='primary'
                          size='small'
                          icon={<PlayCircleOutlined />}
                          onClick={() => handleOpen(project)}
                          disabled={!canOpen}
                        >
                          {t('common.open')}
                        </Button>
                      </Space>
                    </div>
                  </Card>
                )
              })}

              {/* Add Project Card */}
              <Card className={styles.addProjectCard} variant='outlined' onClick={handleAdd}>
                <Space align='center'>
                  <PlusOutlined className={styles.addIcon} />
                  <Text type='secondary'>{t('projects.addProject')}</Text>
                </Space>
              </Card>
            </div>
          )}
        </SimpleBar>
      </div>

      {/* Add/Edit Project Modal */}
      <Modal
        title={editingProject ? t('projects.editProject') : t('projects.addProject')}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false)
          setEditingProject(null)
        }}
        onOk={handleSave}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={520}
        styles={{
          body: { maxHeight: '70vh', overflowY: 'auto' },
        }}
      >
        <Form form={form} layout='vertical' className={styles.form}>
          <Form.Item
            name='name'
            label={t('projects.projectName')}
            rules={[{ required: true, message: t('projects.enterName') }]}
          >
            <Input size='large' placeholder={t('projects.projectNamePlaceholder')} />
          </Form.Item>

          {!editingProject && (
            <Form.Item
              name='path'
              label={t('projects.projectPath')}
              rules={[{ required: true, message: t('projects.selectPath') }]}
            >
              <Input
                size='large'
                placeholder={t('projects.pathPlaceholder')}
                readOnly
                addonAfter={
                  <Button
                    type='text'
                    icon={<FolderAddOutlined />}
                    onClick={handleSelectFolder}
                    size='small'
                  >
                    {t('projects.browse')}
                  </Button>
                }
              />
            </Form.Item>
          )}

          <Form.Item name='remark' label={t('projects.remark')}>
            <TextArea rows={2} placeholder={t('projects.remarkPlaceholder')} />
          </Form.Item>

          <Form.Item
            name='key'
            label={
              <Space>
                <KeyOutlined />
                <span>{t('projects.boundKey')}</span>
              </Space>
            }
          >
            <KeyCascader
              providers={providers}
              apiKeys={allApiKeys}
              size='large'
              placeholder={t('projects.selectKeyOptional')}
            />
          </Form.Item>

          <Form.Item name='cliType' label={t('projects.cliType')} initialValue='claude'>
            <Segmented
              options={[
                {
                  label: (
                    <Space size={6}>
                      <CliTypeIcon type='claude' size={16} />
                      <span>Claude Code</span>
                    </Space>
                  ),
                  value: 'claude',
                },
                {
                  label: (
                    <Space size={6}>
                      <CliTypeIcon type='codex' size={16} />
                      <span>Codex CLI</span>
                    </Space>
                  ),
                  value: 'codex',
                },
              ]}
              block
            />
          </Form.Item>

          {editingProject && (
            <div className={styles.pathInfo}>
              <Text type='secondary' className={styles.pathLabel}>
                {t('projects.projectPath')}
              </Text>
              <Text className={styles.pathValue}>{editingProject.path}</Text>
            </div>
          )}
        </Form>
      </Modal>
    </div>
  )
}
