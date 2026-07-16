import { getApi } from '../api'
/**
 * Projects - 项目管理页面（卡片布局）
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Typography,
  Button,
  theme,
  Card,
  Space,
  Modal,
  Form,
  Input,
  Tooltip,
  Popconfirm,
  Dropdown,
  Badge,
  Tag,
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
  ThunderboltOutlined,
} from '@ant-design/icons'

// Import provider icons
import claudeIcon from '../assets/provider-icons/claude.svg'
import openaiIcon from '../assets/provider-icons/openai.svg'
import deepseekIcon from '../assets/provider-icons/deepseek.svg'
import newapiIcon from '../assets/provider-icons/newapi.svg'

import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../stores/projectStore'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import KeyCascader from '../components/common/KeyCascader'
import SimpleBar from 'simplebar-react'
import type { Project, ApiKey, Provider, ClientKind, ProjectClientBinding } from '@shared/types'
import styles from './Projects.module.css'
import { supportsKeyClient } from '../utils/clientSupport'

const { Title, Text } = Typography
const { TextArea } = Input

// Preset provider icon mapping
const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
}

// Get provider icon src
function getProviderIconSrc(provider: Provider | null): string {
  if (!provider) {
    return PRESET_ICON_MAP.claude
  }
  if (!provider.icon) {
    return PRESET_ICON_MAP['custom'] || PRESET_ICON_MAP.claude
  }
  if (PRESET_ICON_MAP[provider.icon]) {
    return PRESET_ICON_MAP[provider.icon]
  }
  return `file://${provider.icon}`
}

// CLI type icon component
const CliTypeIcon = ({ type, size = 14 }: { type: string; size?: number }) => {
  if (type === 'grok') {
    return <ThunderboltOutlined aria-label='Grok Build' style={{ fontSize: size }} />
  }
  const icon =
    type === 'claude' || type === 'claude_code' || type === 'claude_desktop'
      ? claudeIcon
      : openaiIcon
  return <img src={icon} alt={type} style={{ width: size, height: size }} />
}

const getKeySwitchItemKey = (providerId: string, keyId: string) =>
  JSON.stringify([providerId, keyId])

const parseKeySwitchItemKey = (itemKey: string) => {
  try {
    const parsed = JSON.parse(itemKey)
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { providerId: parsed[0], keyId: parsed[1] }
    }
  } catch {
    return null
  }
  return null
}

type CliProjectKind = Extract<ClientKind, 'claude_code' | 'grok'>

export function getProjectBinding(
  project: Project,
  clientKind: CliProjectKind,
): ProjectClientBinding | null {
  const binding = project.bindings?.[clientKind]
  if (binding) return binding

  const legacyKind = project.cliType === 'claude' ? 'claude_code' : project.cliType
  if (legacyKind !== clientKind) return null
  return {
    cliType: clientKind,
    providerId: project.providerId,
    apiKeyId: project.apiKeyId,
    terminalType: project.terminalType,
    prelaunchCommand: project.prelaunchCommand,
  }
}

export function getProjectDirectory(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (separator <= 0) return normalized || '/'
  return normalized.slice(0, separator)
}

interface ProjectsProps {
  defaultCliType?: CliProjectKind
}

export default function Projects({ defaultCliType = 'claude_code' }: ProjectsProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const message = useAppMessage()
  const {
    projects,
    fetchProjects,
    createProject,
    updateProject,
    updateProjectBinding,
    deleteProject,
  } = useProjectStore()
  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys, getAllApiKeys, apiKeys: apiKeysByProvider } = useApiKeyStore()

  const allApiKeys = getAllApiKeys()

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [form] = Form.useForm()

  useEffect(() => {
    fetchProjects()
    fetchProviders()
  }, [fetchProjects, fetchProviders])

  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map((p) => p.id))
    }
  }, [providers, fetchAllApiKeys])

  const getProvider = (providerId: string | null) => {
    if (!providerId) return null
    return providers.find((p) => p.id === providerId) || null
  }

  const getApiKey = (apiKeyId: string | null): ApiKey | null => {
    if (!apiKeyId) return null
    return allApiKeys.find((k) => k.id === apiKeyId) || null
  }

  const compatibleApiKeys = allApiKeys.filter((apiKey) => {
    const provider = providers.find((item) => item.id === apiKey.providerId)
    return !!provider && supportsKeyClient(provider, apiKey, defaultCliType)
  })

  const getKeyAlias = (key: ApiKey | null) => {
    if (!key) return null
    return key.alias || `Key ${key.priority + 1}`
  }

  const isKeyCompatible = (apiKey: ApiKey | null): boolean => {
    const provider = getProvider(apiKey?.providerId || null)
    return !!apiKey && !!provider && supportsKeyClient(provider, apiKey, defaultCliType)
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
    const binding = getProjectBinding(project, defaultCliType)
    if (!binding?.providerId || !binding.apiKeyId) {
      message.warning(t('projects.configureFirst'))
      handleEdit(project)
      return
    }

    const apiKey = getApiKey(binding.apiKeyId)
    if (!isKeyCompatible(apiKey)) {
      message.warning(t('projects.keyNotCompatible'))
      return
    }

    try {
      await getApi().terminal.launch(project.id, { cliType: defaultCliType })
      message.success(`${t('projects.opened')} ${project.name}`)
      fetchProjects()
    } catch {
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
    const binding = getProjectBinding(project, defaultCliType)
    const apiKey = getApiKey(binding?.apiKeyId || null)
    const keyCompatible = isKeyCompatible(apiKey)
    setEditingProject(project)
    form.setFieldsValue({
      name: project.name,
      path: project.path,
      remark: project.remark,
      key:
        keyCompatible && binding?.providerId && binding.apiKeyId
          ? [binding.providerId, binding.apiKeyId]
          : null,
      prelaunchCommand: binding?.prelaunchCommand || '',
    })
    setModalOpen(true)
  }

  // Quick switch key for a project
  const handleSwitchKey = async (project: Project, providerId: string, keyId: string) => {
    try {
      const binding = getProjectBinding(project, defaultCliType)
      await updateProjectBinding(project.id, {
        cliType: defaultCliType,
        providerId,
        apiKeyId: keyId,
        terminalType: binding?.terminalType || project.terminalType,
        prelaunchCommand: binding?.prelaunchCommand || null,
      })
    } catch {
      message.error(t('messages.error'))
    }
  }

  const handleKeySwitchMenuClick =
    (project: Project): MenuProps['onClick'] =>
    ({ key }) => {
      const target = parseKeySwitchItemKey(String(key))
      const binding = getProjectBinding(project, defaultCliType)
      if (!target || target.keyId === binding?.apiKeyId) {
        return
      }
      handleSwitchKey(project, target.providerId, target.keyId)
    }

  // Build key switch menu items for a project
  const getKeySwitchMenuItems = (project: Project): NonNullable<MenuProps['items']> => {
    const items: NonNullable<MenuProps['items']> = []

    providers.forEach((provider) => {
      if (!provider.isActive) return
      const providerKeys = (apiKeysByProvider[provider.id] || []).filter(
        (key) =>
          key.isActive && !key.isExhausted && supportsKeyClient(provider, key, defaultCliType),
      )
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
          const isCurrent = getProjectBinding(project, defaultCliType)?.apiKeyId === key.id

          return {
            key: getKeySwitchItemKey(provider.id, key.id),
            label: (
              <div className={styles.keySwitchMenuItemContent}>
                <span
                  className={`${styles.keySwitchMenuItemName} ${isCurrent ? styles.keySwitchMenuItemNameCurrent : ''}`}
                >
                  {key.alias || `Key ${key.priority + 1}`}
                </span>
                <div className={styles.keySwitchMenuItemMeta}>
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
      const remark = values.remark?.trim()
      const prelaunchCommand = values.prelaunchCommand?.trim()

      if (values.key) {
        const selectedKey = getApiKey(values.key[1])
        const selectedProvider = getProvider(values.key[0])
        if (
          !selectedKey ||
          !selectedProvider ||
          !supportsKeyClient(selectedProvider, selectedKey, defaultCliType)
        ) {
          message.warning(t('projects.selectCompatibleKey'))
          return
        }
      }

      if (editingProject) {
        await updateProject({
          id: editingProject.id,
          name: values.name,
          remark,
        })
        await updateProjectBinding(editingProject.id, {
          cliType: defaultCliType,
          providerId: values.key?.[0] || null,
          apiKeyId: values.key?.[1] || null,
          terminalType:
            getProjectBinding(editingProject, defaultCliType)?.terminalType ||
            editingProject.terminalType,
          prelaunchCommand: prelaunchCommand || null,
        })
        message.success(t('projects.projectUpdated'))
      } else {
        // Create new project
        await createProject({
          name: values.name,
          path: values.path,
          remark,
          providerId: values.key?.[0],
          apiKeyId: values.key?.[1],
          cliType: defaultCliType,
          prelaunchCommand: prelaunchCommand || '',
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
    } catch {
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
    } catch {
      message.error(t('projects.selectFolderFailed'))
    }
  }

  const projectGroups = useMemo(() => {
    const groups = new Map<string, Project[]>()
    projects.forEach((project) => {
      const directory = getProjectDirectory(project.path)
      groups.set(directory, [...(groups.get(directory) || []), project])
    })
    return Array.from(groups.entries())
      .map(([directory, items]) => ({
        directory,
        projects: items.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.directory.localeCompare(b.directory))
  }, [projects])

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
              {projectGroups.flatMap((group) => [
                <div key={`directory:${group.directory}`} className={styles.directoryHeader}>
                  <div className={styles.directoryTitle}>
                    <FolderOutlined />
                    <Text strong>{group.directory.split(/[\\/]/).pop() || group.directory}</Text>
                    <Badge count={group.projects.length} color={token.colorPrimary} />
                  </div>
                  <Text type='secondary' className={styles.directoryPath}>
                    {group.directory}
                  </Text>
                </div>,
                ...group.projects.map((project) => {
                  const binding = getProjectBinding(project, defaultCliType)
                  const provider = getProvider(binding?.providerId || null)
                  const apiKey = getApiKey(binding?.apiKeyId || null)
                  const hasKey = !!binding?.providerId && !!binding.apiKeyId
                  const keyCompatible = isKeyCompatible(apiKey)
                  const canOpen = hasKey && keyCompatible
                  const remark = project.remark?.trim()

                  return (
                    <Card key={project.id} className={styles.projectCard} variant='outlined'>
                      {/* Card Header */}
                      <div className={styles.projectCardHeader}>
                        <Text strong className={styles.projectName}>
                          {project.name}
                        </Text>
                        <Tag className={styles.clientBindingTag}>
                          <CliTypeIcon type={defaultCliType} size={13} />
                          {defaultCliType === 'grok' ? 'Grok Build' : 'Claude Code'}
                        </Tag>
                      </div>

                      {/* Remark */}
                      <Text type='secondary' className={styles.projectRemark}>
                        {t('projects.remark')}：{remark || t('common.none')}
                      </Text>

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
                            </div>
                            <Dropdown
                              classNames={{ root: styles.keySwitchDropdown }}
                              menu={{
                                items: getKeySwitchMenuItems(project),
                                onClick: handleKeySwitchMenuClick(project),
                                classNames: {
                                  root: styles.keySwitchMenu,
                                },
                              }}
                              trigger={['click']}
                              placement='bottomRight'
                              popupRender={(menus) => (
                                <div className={styles.keySwitchMenuFrame}>
                                  <div className={styles.keySwitchMenuScroller}>{menus}</div>
                                </div>
                              )}
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
                }),
              ])}
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
            name='prelaunchCommand'
            label='启动前命令'
            extra='进入项目目录后、执行所选客户端前运行；留空则不执行。'
          >
            <TextArea
              rows={3}
              placeholder='例如: source .venv/bin/activate'
              className={styles.commandEditor}
            />
          </Form.Item>

          <div className={styles.bindingContext}>
            <CliTypeIcon type={defaultCliType} size={16} />
            <div>
              <Text strong>
                {defaultCliType === 'grok' ? 'Grok Build 绑定' : 'Claude Code 绑定'}
              </Text>
              <Text type='secondary'>
                项目目录会在两个客户端间复用，这里的供应商、密钥和启动命令只属于当前客户端。
              </Text>
            </div>
          </div>

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
              apiKeys={compatibleApiKeys}
              size='large'
              placeholder={t('projects.selectKeyOptional')}
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
