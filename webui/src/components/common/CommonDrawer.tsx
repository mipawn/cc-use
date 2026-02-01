import { useState, useEffect } from 'react';
import { Drawer, Button, Input, Empty, message } from 'antd';
import { PlusOutlined, DeleteOutlined, CloseOutlined } from '@ant-design/icons';
import type { Common } from '../../api/client';
import { useCommonStore } from '../../stores/common';
import { useUIStore, t } from '../../stores/ui';
import ProviderTypeSegmented from '../ProviderTypeSegmented';

interface EnvItem {
  key: string;
  value: string;
}

export default function CommonDrawer() {
  const { common, updateCommon, fetchCommon } = useCommonStore();
  const { language, isCommonDrawerOpen, setCommonDrawerOpen } = useUIStore();
  const [activeTab, setActiveTab] = useState<'_global' | 'claude' | 'codex'>('_global');
  const [editingItems, setEditingItems] = useState<EnvItem[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (isCommonDrawerOpen) {
      loadTabData(activeTab);
    }
  }, [isCommonDrawerOpen, activeTab, common]);

  const loadTabData = (tab: string) => {
    const values = common[tab as keyof Common] || {};
    setEditingItems(Object.entries(values).map(([key, value]) => ({ key, value })));
    setHasChanges(false);
  };

  const handleSave = async () => {
    const values: Record<string, string> = {};
    editingItems.forEach((item) => {
      if (item.key.trim()) {
        values[item.key.trim()] = item.value;
      }
    });

    try {
      await updateCommon(activeTab, values);
      message.success(t('保存成功', 'Saved successfully', language));
      setHasChanges(false);
      fetchCommon();
    } catch {
      message.error(t('保存失败', 'Save failed', language));
    }
  };

  const addItem = () => {
    setEditingItems([...editingItems, { key: '', value: '' }]);
    setHasChanges(true);
  };

  const removeItem = (index: number) => {
    setEditingItems(editingItems.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const updateItem = (index: number, field: 'key' | 'value', value: string) => {
    const newItems = [...editingItems];
    newItems[index][field] = value;
    setEditingItems(newItems);
    setHasChanges(true);
  };

  const isSensitiveKey = (key: string) => {
    const patterns = ['token', 'key', 'secret', 'password', 'auth'];
    return patterns.some((p) => key.toLowerCase().includes(p));
  };

  return (
    <Drawer
      title={
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold text-slate-800">
            {t('通用配置', 'Common Config', language)}
          </span>
          <Button
            type="text"
            icon={<CloseOutlined />}
            onClick={() => setCommonDrawerOpen(false)}
            className="text-slate-400"
          />
        </div>
      }
      placement="right"
      styles={{
        wrapper: { width: 480 },
        header: { borderBottom: '1px solid #e2e8f0', padding: '16px 20px' },
        body: { padding: 0 },
        footer: { borderTop: '1px solid #e2e8f0', padding: '12px 20px' },
      }}
      open={isCommonDrawerOpen}
      onClose={() => setCommonDrawerOpen(false)}
      closable={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={() => setCommonDrawerOpen(false)}>
            {t('关闭', 'Close', language)}
          </Button>
          <Button type="primary" onClick={handleSave} disabled={!hasChanges}>
            {t('保存', 'Save', language)}
          </Button>
        </div>
      }
    >
      <div className="p-5">
        <div className="mb-4">
          <ProviderTypeSegmented
            value={activeTab}
            onChange={(val) => setActiveTab(val as '_global' | 'claude' | 'codex')}
            showGlobal
            size="small"
          />
        </div>

        <div className="pt-2">
          {editingItems.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('暂无配置', 'No config', language)}
              className="py-8"
            />
          ) : (
            <div className="space-y-3">
              {editingItems.map((item, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <Input
                    placeholder="KEY"
                    value={item.key}
                    onChange={(e) => updateItem(index, 'key', e.target.value)}
                    className="flex-1 font-mono text-sm"
                  />
                  <Input
                    placeholder="VALUE"
                    value={item.value}
                    onChange={(e) => updateItem(index, 'value', e.target.value)}
                    type={isSensitiveKey(item.key) ? 'password' : 'text'}
                    className="flex-[2] font-mono text-sm"
                  />
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeItem(index)}
                  />
                </div>
              ))}
            </div>
          )}

          <Button
            type="dashed"
            onClick={addItem}
            icon={<PlusOutlined />}
            className="w-full mt-4"
          >
            {t('添加配置项', 'Add Config', language)}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
