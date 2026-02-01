import { useState } from 'react';
import { Collapse, Typography, Tag, Button, Space, Empty, Modal, Input, message } from 'antd';
import { EditOutlined, GlobalOutlined, CodeOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { Common } from '../api/client';
import { useCommonStore } from '../stores/common';

const { Text } = Typography;

interface CommonConfigProps {
  common: Common;
  loading: boolean;
  language: 'zh' | 'en';
}

interface EnvItem {
  key: string;
  value: string;
}

export default function CommonConfig({ common, language }: CommonConfigProps) {
  const [editingType, setEditingType] = useState<string | null>(null);
  const [editingItems, setEditingItems] = useState<EnvItem[]>([]);
  const { updateCommon } = useCommonStore();

  const types = [
    {
      key: '_global',
      label: language === 'zh' ? '全局配置' : 'Global',
      icon: <GlobalOutlined />,
      color: 'blue',
      description: language === 'zh' ? '所有 CLI 工具共享' : 'Shared by all CLI tools',
    },
    {
      key: 'claude',
      label: 'Claude',
      icon: <CodeOutlined />,
      color: 'purple',
      description: language === 'zh' ? 'Claude Code 专属' : 'Claude Code specific',
    },
    {
      key: 'codex',
      label: 'Codex',
      icon: <CodeOutlined />,
      color: 'green',
      description: language === 'zh' ? 'Codex CLI 专属' : 'Codex CLI specific',
    },
  ];

  const handleEdit = (type: string) => {
    const values = common[type as keyof Common] || {};
    setEditingItems(Object.entries(values).map(([key, value]) => ({ key, value })));
    setEditingType(type);
  };

  const handleSave = async () => {
    if (!editingType) return;

    const values: Record<string, string> = {};
    editingItems.forEach((item) => {
      if (item.key.trim()) {
        values[item.key.trim()] = item.value;
      }
    });

    try {
      await updateCommon(editingType, values);
      message.success(language === 'zh' ? '保存成功' : 'Saved successfully');
      setEditingType(null);
    } catch (err) {
      message.error(language === 'zh' ? '保存失败' : 'Save failed');
    }
  };

  const addItem = () => {
    setEditingItems([...editingItems, { key: '', value: '' }]);
  };

  const removeItem = (index: number) => {
    setEditingItems(editingItems.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: 'key' | 'value', value: string) => {
    const newItems = [...editingItems];
    newItems[index][field] = value;
    setEditingItems(newItems);
  };

  const isSensitiveKey = (key: string) => {
    const patterns = ['token', 'key', 'secret', 'password', 'auth'];
    return patterns.some((p) => key.toLowerCase().includes(p));
  };

  const renderValues = (values: Record<string, string> | undefined) => {
    if (!values || Object.keys(values).length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={language === 'zh' ? '暂无配置' : 'No config'}
        />
      );
    }

    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(values).map(([key, value]) => (
          <Tag key={key} style={{ margin: 0 }}>
            <Text code style={{ marginRight: 4 }}>{key}</Text>
            =
            <Text style={{ marginLeft: 4 }}>
              {isSensitiveKey(key) ? '****' : value}
            </Text>
          </Tag>
        ))}
      </div>
    );
  };

  const items = types.map((type) => {
    const values = common[type.key as keyof Common];
    const count = values ? Object.keys(values).length : 0;

    return {
      key: type.key,
      label: (
        <Space>
          {type.icon}
          <Text strong>{type.label}</Text>
          <Tag color={type.color}>{count}</Tag>
        </Space>
      ),
      extra: (
        <Button
          type="text"
          size="small"
          icon={<EditOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            handleEdit(type.key);
          }}
        >
          {language === 'zh' ? '编辑' : 'Edit'}
        </Button>
      ),
      children: (
        <div>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            {type.description}
          </Text>
          {renderValues(values)}
        </div>
      ),
    };
  });

  return (
    <>
      <div
        style={{
          background: '#fff',
          padding: 16,
          borderRadius: 8,
          marginBottom: 16,
          boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
        }}
      >
        <Text strong style={{ fontSize: 16, display: 'block', marginBottom: 12 }}>
          {language === 'zh' ? '通用配置 (Common)' : 'Common Config'}
        </Text>
        <Collapse items={items} bordered={false} />
      </div>

      {/* Edit Modal */}
      <Modal
        title={`${language === 'zh' ? '编辑' : 'Edit'} ${types.find((t) => t.key === editingType)?.label || ''}`}
        open={!!editingType}
        onCancel={() => setEditingType(null)}
        onOk={handleSave}
        width={560}
      >
        {editingItems.map((item, index) => (
          <Space key={index} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <Input
              placeholder="KEY"
              value={item.key}
              onChange={(e) => updateItem(index, 'key', e.target.value)}
              style={{ width: 180 }}
            />
            <Input
              placeholder="VALUE"
              value={item.value}
              onChange={(e) => updateItem(index, 'value', e.target.value)}
              type={isSensitiveKey(item.key) ? 'password' : 'text'}
              style={{ width: 240 }}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeItem(index)}
            />
          </Space>
        ))}

        <Button
          type="dashed"
          onClick={addItem}
          icon={<PlusOutlined />}
          style={{ width: '100%', marginTop: 8 }}
        >
          {language === 'zh' ? '添加配置项' : 'Add Config Item'}
        </Button>
      </Modal>
    </>
  );
}
