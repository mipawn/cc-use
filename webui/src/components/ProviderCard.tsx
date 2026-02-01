import { Card, Tag, Typography, Space, Button, Popconfirm, message, Tooltip } from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  CopyOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import type { Provider } from '../api/client';
import { useProvidersStore } from '../stores/providers';
import claudeIcon from '../assets/claude-icon.svg';
import codexIcon from '../assets/codex-icon.svg';

const { Text, Paragraph } = Typography;

interface ProviderCardProps {
  provider: Provider;
  onEdit: () => void;
  language: 'zh' | 'en';
}

export default function ProviderCard({ provider, onEdit, language }: ProviderCardProps) {
  const { deleteProvider, duplicateProvider } = useProvidersStore();

  const handleDelete = async () => {
    try {
      await deleteProvider(provider.id);
      message.success(language === 'zh' ? '删除成功' : 'Deleted successfully');
    } catch (err) {
      message.error(language === 'zh' ? '删除失败' : 'Delete failed');
    }
  };

  const handleDuplicate = async () => {
    const newName = `${provider.name}-copy`;
    try {
      await duplicateProvider(provider.id, newName);
      message.success(language === 'zh' ? '复制成功' : 'Duplicated successfully');
    } catch (err) {
      message.error(language === 'zh' ? '复制失败' : 'Duplicate failed');
    }
  };

  const handleRefreshUsage = async () => {
    // TODO: 实现用量刷新
    message.info(language === 'zh' ? '用量刷新功能开发中' : 'Usage refresh coming soon');
  };

  // 用量状态图标
  const getUsageStatusIcon = () => {
    if (!provider.usageConfig?.enabled) {
      return <MinusCircleOutlined style={{ color: '#999' }} />;
    }
    if (provider.usageData?.error) {
      return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    }
    return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
  };

  // 用量显示
  const renderUsage = () => {
    if (!provider.usageConfig?.enabled) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {language === 'zh' ? '未配置用量' : 'Usage not configured'}
        </Text>
      );
    }

    if (provider.usageData?.error) {
      return (
        <Text type="danger" style={{ fontSize: 12 }}>
          {language === 'zh' ? '查询失败' : 'Query failed'}
        </Text>
      );
    }

    if (provider.usageData?.remaining !== undefined) {
      const unit = provider.usageData.unit || '';
      return (
        <Text style={{ fontSize: 12 }}>
          {language === 'zh' ? '剩余: ' : 'Remaining: '}
          <Text strong style={{ color: '#1890ff' }}>
            {unit === 'USD' ? '$' : ''}
            {provider.usageData.remaining.toFixed(2)}
            {unit && unit !== 'USD' ? ` ${unit}` : ''}
          </Text>
        </Text>
      );
    }

    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {language === 'zh' ? '点击刷新' : 'Click to refresh'}
      </Text>
    );
  };

  const typeIcon = provider.type === 'claude' ? claudeIcon : codexIcon;
  const typeColor = provider.type === 'claude' ? 'purple' : 'green';

  return (
    <Card
      size="small"
      hoverable
      style={{ height: '100%' }}
      styles={{
        body: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: 16,
        },
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <img
          src={typeIcon}
          alt={provider.type}
          style={{ width: 24, height: 24, marginRight: 8 }}
        />
        <Tag color={typeColor} style={{ margin: 0 }}>
          {provider.type === 'claude' ? 'Claude' : 'Codex'}
        </Tag>
        <div style={{ marginLeft: 'auto' }}>
          {getUsageStatusIcon()}
        </div>
      </div>

      {/* Name */}
      <Text strong style={{ fontSize: 16, marginBottom: 4 }}>
        {provider.name}
      </Text>

      {/* Description */}
      {provider.description && (
        <Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 8, fontSize: 13 }}
        >
          {provider.description}
        </Paragraph>
      )}

      {/* Usage */}
      <div style={{ marginBottom: 12 }}>
        {renderUsage()}
      </div>

      {/* Meta */}
      <div style={{ marginTop: 'auto' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {Object.keys(provider.env).length} {language === 'zh' ? '个环境变量' : 'env vars'}
        </Text>
      </div>

      {/* Actions */}
      <div style={{ marginTop: 12, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
        <Space size="small">
          <Tooltip title={language === 'zh' ? '刷新用量' : 'Refresh usage'}>
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              onClick={handleRefreshUsage}
              disabled={!provider.usageConfig?.enabled}
            />
          </Tooltip>
          <Tooltip title={language === 'zh' ? '编辑' : 'Edit'}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={onEdit}
            />
          </Tooltip>
          <Tooltip title={language === 'zh' ? '复制' : 'Duplicate'}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={handleDuplicate}
            />
          </Tooltip>
          <Popconfirm
            title={language === 'zh' ? '确定删除？' : 'Are you sure?'}
            onConfirm={handleDelete}
            okText={language === 'zh' ? '确定' : 'Yes'}
            cancelText={language === 'zh' ? '取消' : 'No'}
          >
            <Tooltip title={language === 'zh' ? '删除' : 'Delete'}>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      </div>
    </Card>
  );
}
