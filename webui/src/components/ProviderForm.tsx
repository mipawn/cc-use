import { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Tabs,
  Button,
  Space,
  message,
  Divider,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { Provider, UsageConfig } from '../api/client';
import { createProvider, updateProvider, getProvider } from '../api/client';
import { useProvidersStore } from '../stores/providers';

interface ProviderFormProps {
  open: boolean;
  providerId: string | null;
  onClose: () => void;
  language: 'zh' | 'en';
}

interface EnvItem {
  key: string;
  value: string;
}

export default function ProviderForm({ open, providerId, onClose, language }: ProviderFormProps) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [envItems, setEnvItems] = useState<EnvItem[]>([]);
  const [usageEnabled, setUsageEnabled] = useState(false);
  const { fetchProviders } = useProvidersStore();

  const isEdit = !!providerId;

  // Load provider data when editing
  useEffect(() => {
    if (open && providerId) {
      setLoading(true);
      getProvider(providerId)
        .then((provider) => {
          form.setFieldsValue({
            name: provider.name,
            type: provider.type,
            description: provider.description,
            websiteUrl: provider.websiteUrl,
            usageTemplateType: provider.usageConfig?.templateType || 'newapi',
            usageBaseUrl: provider.usageConfig?.baseUrl,
            usageAccessToken: provider.usageConfig?.accessToken,
            usageUserId: provider.usageConfig?.userId,
            usageCustomScript: provider.usageConfig?.customScript,
          });
          setEnvItems(
            Object.entries(provider.env).map(([key, value]) => ({ key, value }))
          );
          setUsageEnabled(provider.usageConfig?.enabled || false);
        })
        .catch(() => {
          message.error(language === 'zh' ? '加载失败' : 'Failed to load');
        })
        .finally(() => {
          setLoading(false);
        });
    } else if (open) {
      // Reset form for new provider
      form.resetFields();
      form.setFieldsValue({ type: 'claude', usageTemplateType: 'newapi' });
      setEnvItems([]);
      setUsageEnabled(false);
    }
  }, [open, providerId, form, language]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      // Build env object
      const env: Record<string, string> = {};
      envItems.forEach((item) => {
        if (item.key.trim()) {
          env[item.key.trim()] = item.value;
        }
      });

      // Build usage config
      let usageConfig: UsageConfig | undefined;
      if (usageEnabled) {
        usageConfig = {
          enabled: true,
          templateType: values.usageTemplateType,
        };
        if (values.usageTemplateType === 'newapi') {
          usageConfig.baseUrl = values.usageBaseUrl;
          usageConfig.accessToken = values.usageAccessToken;
          usageConfig.userId = values.usageUserId;
        } else {
          usageConfig.customScript = values.usageCustomScript;
        }
      }

      const providerData: Partial<Provider> = {
        name: values.name,
        type: values.type,
        description: values.description,
        websiteUrl: values.websiteUrl,
        env,
        usageConfig,
      };

      if (isEdit && providerId) {
        await updateProvider(providerId, providerData);
        message.success(language === 'zh' ? '更新成功' : 'Updated successfully');
      } else {
        await createProvider(providerData);
        message.success(language === 'zh' ? '创建成功' : 'Created successfully');
      }

      fetchProviders();
      onClose();
    } catch (err) {
      if (err instanceof Error) {
        message.error(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const addEnvItem = () => {
    setEnvItems([...envItems, { key: '', value: '' }]);
  };

  const removeEnvItem = (index: number) => {
    setEnvItems(envItems.filter((_, i) => i !== index));
  };

  const updateEnvItem = (index: number, field: 'key' | 'value', value: string) => {
    const newItems = [...envItems];
    newItems[index][field] = value;
    setEnvItems(newItems);
  };

  const isSensitiveKey = (key: string) => {
    const patterns = ['token', 'key', 'secret', 'password', 'auth'];
    return patterns.some((p) => key.toLowerCase().includes(p));
  };

  return (
    <Modal
      title={isEdit ? (language === 'zh' ? '编辑供应商' : 'Edit Provider') : (language === 'zh' ? '新增供应商' : 'New Provider')}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={640}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Tabs
          items={[
            {
              key: 'basic',
              label: language === 'zh' ? '基本信息' : 'Basic Info',
              children: (
                <>
                  <Form.Item
                    name="name"
                    label={language === 'zh' ? '名称' : 'Name'}
                    rules={[
                      { required: true, message: language === 'zh' ? '请输入名称' : 'Name is required' },
                      {
                        pattern: /^[a-zA-Z0-9_-]+$/,
                        message: language === 'zh' ? '只能包含字母、数字、下划线和连字符' : 'Only letters, numbers, underscores and hyphens',
                      },
                    ]}
                  >
                    <Input disabled={isEdit} placeholder="my-provider" />
                  </Form.Item>

                  <Form.Item
                    name="type"
                    label={language === 'zh' ? '类型' : 'Type'}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={[
                        { value: 'claude', label: 'Claude Code' },
                        { value: 'codex', label: 'Codex CLI' },
                      ]}
                    />
                  </Form.Item>

                  <Form.Item
                    name="description"
                    label={language === 'zh' ? '描述' : 'Description'}
                  >
                    <Input.TextArea rows={2} placeholder={language === 'zh' ? '可选描述' : 'Optional description'} maxLength={200} showCount />
                  </Form.Item>

                  <Form.Item
                    name="websiteUrl"
                    label={language === 'zh' ? '官网链接' : 'Website URL'}
                    rules={[
                      { type: 'url', message: language === 'zh' ? '请输入有效的 URL' : 'Please enter a valid URL' },
                    ]}
                  >
                    <Input placeholder="https://example.com" />
                  </Form.Item>

                  <Divider>{language === 'zh' ? '环境变量' : 'Environment Variables'}</Divider>

                  {envItems.map((item, index) => (
                    <Space key={index} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                      <Input
                        placeholder="KEY"
                        value={item.key}
                        onChange={(e) => updateEnvItem(index, 'key', e.target.value)}
                        style={{ width: 180 }}
                      />
                      <Input
                        placeholder="VALUE"
                        value={item.value}
                        onChange={(e) => updateEnvItem(index, 'value', e.target.value)}
                        type={isSensitiveKey(item.key) ? 'password' : 'text'}
                        style={{ width: 280 }}
                      />
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeEnvItem(index)}
                      />
                    </Space>
                  ))}

                  <Button
                    type="dashed"
                    onClick={addEnvItem}
                    icon={<PlusOutlined />}
                    style={{ width: '100%' }}
                  >
                    {language === 'zh' ? '添加环境变量' : 'Add Environment Variable'}
                  </Button>
                </>
              ),
            },
            {
              key: 'usage',
              label: language === 'zh' ? '用量查询' : 'Usage Query',
              children: (
                <>
                  <Form.Item label={language === 'zh' ? '启用用量查询' : 'Enable Usage Query'}>
                    <Switch checked={usageEnabled} onChange={setUsageEnabled} />
                  </Form.Item>

                  {usageEnabled && (
                    <>
                      <Form.Item
                        name="usageTemplateType"
                        label={language === 'zh' ? '模板类型' : 'Template Type'}
                      >
                        <Select
                          options={[
                            { value: 'newapi', label: 'New API' },
                            { value: 'custom', label: language === 'zh' ? '自定义' : 'Custom' },
                          ]}
                        />
                      </Form.Item>

                      <Form.Item noStyle shouldUpdate={(prev, curr) => prev.usageTemplateType !== curr.usageTemplateType}>
                        {({ getFieldValue }) =>
                          getFieldValue('usageTemplateType') === 'newapi' ? (
                            <>
                              <Form.Item
                                name="usageBaseUrl"
                                label="Base URL"
                                rules={[{ required: usageEnabled, message: 'Base URL is required' }]}
                              >
                                <Input placeholder="https://api.example.com" />
                              </Form.Item>
                              <Form.Item
                                name="usageAccessToken"
                                label="Access Token"
                                rules={[{ required: usageEnabled, message: 'Access Token is required' }]}
                              >
                                <Input.Password placeholder="your-access-token" />
                              </Form.Item>
                              <Form.Item
                                name="usageUserId"
                                label="User ID"
                              >
                                <Input placeholder="114514" />
                              </Form.Item>
                            </>
                          ) : (
                            <Form.Item
                              name="usageCustomScript"
                              label={language === 'zh' ? '自定义脚本' : 'Custom Script'}
                            >
                              <Input.TextArea
                                rows={10}
                                placeholder={`({
  request: {
    url: "https://api.example.com/v1/usage",
    method: "GET",
    headers: {
      "Authorization": "Bearer YOUR_API_KEY"
    }
  },
  extractor: function (response) {
    return {
      remaining: response.remaining_quota,
      unit: "USD"
    }
  }
})`}
                              />
                            </Form.Item>
                          )
                        }
                      </Form.Item>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}
