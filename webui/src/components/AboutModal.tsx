import { Modal, Typography, Space, Divider, Tag, Button } from 'antd';
import { GithubOutlined, LinkOutlined } from '@ant-design/icons';
import { useUIStore, t } from '../stores/ui';

const { Title, Text, Paragraph, Link } = Typography;

export default function AboutModal() {
  const { language, isAboutOpen, setAboutOpen } = useUIStore();
  const version = '0.2.0';

  return (
    <Modal
      title={t('关于 CC-Use', 'About CC-Use', language)}
      open={isAboutOpen}
      onCancel={() => setAboutOpen(false)}
      footer={[
        <Button key="close" onClick={() => setAboutOpen(false)}>
          {t('关闭', 'Close', language)}
        </Button>,
      ]}
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <Title level={3} style={{ margin: 0 }} className="text-primary">
            CC-Use
          </Title>
          <Tag color="purple" style={{ marginTop: 8 }}>
            v{version}
          </Tag>
        </div>

        <Paragraph style={{ textAlign: 'center' }}>
          {t(
            'CLI 工具，用于管理多个 Claude Code / Codex CLI 配置',
            'CLI tool for managing multiple Claude Code / Codex CLI configurations',
            language
          )}
        </Paragraph>

        <Divider />

        <div>
          <Text strong>{t('功能特性', 'Features', language)}</Text>
          <ul style={{ marginTop: 8, paddingLeft: 20 }}>
            <li>
              {t('管理多个 API 供应商配置', 'Manage multiple API provider configurations', language)}
            </li>
            <li>
              {t('支持 Claude Code 和 Codex CLI', 'Support Claude Code and Codex CLI', language)}
            </li>
            <li>{t('用量查询（NewAPI / 自定义）', 'Usage query (NewAPI / Custom)', language)}</li>
            <li>{t('配置导入/导出', 'Config import/export', language)}</li>
            <li>{t('交互式选择', 'Interactive selection', language)}</li>
            <li>{t('拖拽排序供应商', 'Drag and drop provider sorting', language)}</li>
          </ul>
        </div>

        <Divider />

        <Space direction="vertical" style={{ width: '100%' }}>
          <Link href="https://github.com/mipawn/cc-use" target="_blank">
            <Space>
              <GithubOutlined />
              GitHub Repository
            </Space>
          </Link>
          <Link href="https://github.com/mipawn/cc-use/issues" target="_blank">
            <Space>
              <LinkOutlined />
              {t('报告问题', 'Report Issues', language)}
            </Space>
          </Link>
        </Space>

        <Divider />

        <Text type="secondary" style={{ display: 'block', textAlign: 'center' }}>
          MIT License © 2026 mipawn
        </Text>
      </Space>
    </Modal>
  );
}
