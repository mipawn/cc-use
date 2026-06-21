/**
 * Claude Code 页面 — 进程级接入点
 * 三个 Tab: 项目 / 实例 / 会话
 */
import { Tabs } from 'antd'
import { useTranslation } from 'react-i18next'
import Projects from './Projects'
import Instances from './Instances'
import Sessions from './Sessions'

export default function ClaudeCodePage() {
  const { t } = useTranslation()

  const items = [
    {
      key: 'projects',
      label: t('common.projects') || '项目',
      children: <Projects />,
    },
    {
      key: 'instances',
      label: t('instances.title') || '实例',
      children: <Instances />,
    },
    {
      key: 'sessions',
      label: '会话',
      children: <Sessions />,
    },
  ]

  return (
    <div className='page-container'>
      <Tabs defaultActiveKey='projects' items={items} />
    </div>
  )
}
