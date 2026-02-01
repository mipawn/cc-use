import { useState, useEffect, useMemo } from "react";
import {
  Drawer,
  Form,
  Input,
  Switch,
  Button,
  message,
  Tabs,
  Segmented,
} from "antd";
import { CloseOutlined, CodeOutlined, LockOutlined } from "@ant-design/icons";
import type { Provider, UsageConfig, CLIType } from "../../api/client";
import { createProvider, updateProvider, getProvider, getCommon } from "../../api/client";
import { useProvidersStore } from "../../stores/providers";
import { useUIStore, t } from "../../stores/ui";
import ProviderTypeSegmented from "../ProviderTypeSegmented";

interface EnvItem {
  key: string;
  value: string;
}

export default function ProviderDrawer() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [envItems, setEnvItems] = useState<EnvItem[]>([]);
  const [usageEnabled, setUsageEnabled] = useState(false);
  const [providerType, setProviderType] = useState<"claude" | "codex">("claude");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [commonConfig, setCommonConfig] = useState<Record<string, Record<string, string>>>({});

  const { fetchProviders } = useProvidersStore();
  const { language, isDrawerOpen, editingProviderId, closeDrawer } = useUIStore();

  const isEdit = !!editingProviderId;

  // Load common config
  useEffect(() => {
    if (isDrawerOpen) {
      getCommon().then(setCommonConfig).catch(() => {});
    }
  }, [isDrawerOpen]);

  useEffect(() => {
    if (isDrawerOpen && editingProviderId) {
      setLoading(true);
      getProvider(editingProviderId)
        .then((provider) => {
          form.setFieldsValue({
            name: provider.name,
            description: provider.description,
            usageTemplateType: provider.usageConfig?.templateType || "newapi",
            usageBaseUrl: provider.usageConfig?.baseUrl,
            usageAccessToken: provider.usageConfig?.accessToken,
            usageUserId: provider.usageConfig?.userId,
            usageCustomScript: provider.usageConfig?.customScript,
          });
          setProviderType(provider.type);
          setWebsiteUrl(provider.websiteUrl || "");
          setBaseUrl(provider.env?.ANTHROPIC_BASE_URL || provider.env?.OPENAI_BASE_URL || "");
          setAccessToken(provider.env?.ANTHROPIC_API_KEY || provider.env?.OPENAI_API_KEY || "");
          setEnvItems(
            Object.entries(provider.env)
              .filter(([key]) => !["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key))
              .map(([key, value]) => ({ key, value }))
          );
          setUsageEnabled(provider.usageConfig?.enabled || false);
        })
        .catch(() => {
          message.error(t("加载失败", "Failed to load", language));
        })
        .finally(() => {
          setLoading(false);
        });
    } else if (isDrawerOpen) {
      form.resetFields();
      form.setFieldsValue({ usageTemplateType: "newapi" });
      setProviderType("claude");
      setWebsiteUrl("");
      setBaseUrl("");
      setAccessToken("");
      setEnvItems([]);
      setUsageEnabled(false);
    }
  }, [isDrawerOpen, editingProviderId, form, language]);

  // Global config (read-only)
  const globalConfig = useMemo(() => {
    const globalCommon = commonConfig._global || {};
    const typeCommon = commonConfig[providerType] || {};
    return { ...globalCommon, ...typeCommon };
  }, [commonConfig, providerType]);

  // Current provider config (editable)
  const currentConfig = useMemo(() => {
    const config: Record<string, string> = {};
    if (baseUrl) {
      const urlKey = providerType === "claude" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
      config[urlKey] = baseUrl;
    }
    if (accessToken) {
      const tokenKey = providerType === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      config[tokenKey] = accessToken;
    }
    envItems.forEach((item) => {
      if (item.key.trim()) {
        config[item.key.trim()] = item.value;
      }
    });
    return config;
  }, [baseUrl, accessToken, envItems, providerType]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const env: Record<string, string> = { ...currentConfig };

      let usageConfig: UsageConfig | undefined;
      if (usageEnabled) {
        usageConfig = {
          enabled: true,
          templateType: values.usageTemplateType,
        };
        if (values.usageTemplateType === "newapi") {
          usageConfig.baseUrl = values.usageBaseUrl;
          usageConfig.accessToken = values.usageAccessToken;
          usageConfig.userId = values.usageUserId;
        } else {
          usageConfig.customScript = values.usageCustomScript;
        }
      }

      const providerData: Partial<Provider> = {
        name: values.name,
        type: providerType,
        description: values.description,
        websiteUrl: websiteUrl || undefined,
        env,
        usageConfig,
      };

      if (isEdit && editingProviderId) {
        await updateProvider(editingProviderId, providerData);
        message.success(t("更新成功", "Updated successfully", language));
      } else {
        await createProvider(providerData);
        message.success(t("创建成功", "Created successfully", language));
      }

      fetchProviders();
      closeDrawer();
    } catch (err) {
      if (err instanceof Error) {
        message.error(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer
      title={
        <div className="flex items-center justify-between">
          <span className="text-base font-semibold text-slate-800">
            {isEdit
              ? t("编辑供应商", "Edit Provider", language)
              : t("新增供应商", "New Provider", language)}
          </span>
          <Button
            type="text"
            icon={<CloseOutlined />}
            onClick={closeDrawer}
            className="text-slate-400"
          />
        </div>
      }
      placement="right"
      styles={{
        wrapper: { width: 480 },
        header: { borderBottom: "1px solid #e2e8f0", padding: "16px 20px" },
        body: { padding: 0 },
        footer: { borderTop: "1px solid #e2e8f0", padding: "12px 20px" },
      }}
      open={isDrawerOpen}
      onClose={closeDrawer}
      closable={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={closeDrawer}>{t("取消", "Cancel", language)}</Button>
          <Button type="primary" onClick={handleSubmit} loading={loading}>
            {isEdit
              ? t("保存", "Save", language)
              : t("创建", "Create", language)}
          </Button>
        </div>
      }
    >
      <div className="p-5">
        <Form form={form} layout="vertical">
          <Tabs
            items={[
              {
                key: "basic",
                label: t("基本信息", "Basic Info", language),
                children: (
                  <div className="pt-3 space-y-4">
                    {/* Type Selector */}
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        {t("类型", "Type", language)}
                      </label>
                      <ProviderTypeSegmented
                        value={providerType}
                        onChange={(val) => setProviderType(val as CLIType)}
                        disabled={isEdit}
                        size="small"
                      />
                    </div>

                    <Form.Item
                      name="name"
                      label={<span className="text-slate-700">{t("名称", "Name", language)}</span>}
                      rules={[
                        {
                          required: true,
                          message: t("请输入名称", "Name is required", language),
                        },
                      ]}
                      className="mb-0"
                    >
                      <Input
                        disabled={isEdit}
                        placeholder={t("我的供应商", "my-provider", language)}
                        size="large"
                      />
                    </Form.Item>

                    <Form.Item
                      name="description"
                      label={<span className="text-slate-700">{t("描述", "Description", language)}</span>}
                      className="mb-0"
                    >
                      <Input.TextArea
                        rows={2}
                        placeholder={t("可选描述", "Optional description", language)}
                        maxLength={200}
                        showCount
                      />
                    </Form.Item>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        {t("官网链接", "Website URL", language)}
                      </label>
                      <Input
                        value={websiteUrl}
                        onChange={(e) => setWebsiteUrl(e.target.value)}
                        placeholder="https://example.com"
                        size="large"
                      />
                    </div>

                    {/* API Configuration */}
                    <div className="pt-2">
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        Base URL
                      </label>
                      <Input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="https://api.example.com"
                        size="large"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">
                        API Key / Token
                      </label>
                      <Input.Password
                        value={accessToken}
                        onChange={(e) => setAccessToken(e.target.value)}
                        placeholder="sk-xxx"
                        size="large"
                      />
                    </div>

                    {/* Config Preview - Split into global (readonly) and current (editable) */}
                    <div className="pt-2">
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
                        <CodeOutlined />
                        <span>{t("配置预览", "Config Preview", language)}</span>
                      </div>

                      {/* Global Config - Read Only */}
                      {Object.keys(globalConfig).length > 0 && (
                        <div className="mb-2">
                          <div className="flex items-center gap-1 text-xs text-slate-400 mb-1">
                            <LockOutlined className="text-[10px]" />
                            <span>{t("全局配置（只读）", "Global Config (Read-only)", language)}</span>
                          </div>
                          <pre className="bg-slate-100 text-slate-500 p-2 rounded text-xs overflow-auto max-h-20 font-mono border border-slate-200">
                            {JSON.stringify(globalConfig, null, 2)}
                          </pre>
                        </div>
                      )}

                      {/* Current Provider Config - Editable display */}
                      <div>
                        <div className="text-xs text-slate-500 mb-1">
                          {t("当前配置", "Current Config", language)}
                        </div>
                        <pre className="bg-slate-50 text-slate-600 p-2 rounded text-xs overflow-auto max-h-24 font-mono border border-slate-200">
                          {Object.keys(currentConfig).length > 0
                            ? JSON.stringify(currentConfig, null, 2)
                            : t("暂无配置", "No config", language)}
                        </pre>
                      </div>
                    </div>
                  </div>
                ),
              },
              {
                key: "usage",
                label: t("用量查询", "Usage Query", language),
                children: (
                  <div className="pt-3 space-y-4">
                    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
                      <span className="text-sm text-slate-700">
                        {t("启用用量查询", "Enable Usage Query", language)}
                      </span>
                      <Switch
                        checked={usageEnabled}
                        onChange={setUsageEnabled}
                      />
                    </div>

                    {usageEnabled && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-2">
                            {t("模板类型", "Template Type", language)}
                          </label>
                          <Segmented
                            options={[
                              { value: "newapi", label: "New API" },
                              {
                                value: "custom",
                                label: t("自定义", "Custom", language),
                              },
                            ]}
                            value={
                              form.getFieldValue("usageTemplateType") ||
                              "newapi"
                            }
                            onChange={(val) =>
                              form.setFieldValue("usageTemplateType", val)
                            }
                            className="type-tabs-segmented-sm"
                          />
                        </div>

                        <Form.Item
                          noStyle
                          shouldUpdate={(prev, curr) =>
                            prev.usageTemplateType !== curr.usageTemplateType
                          }
                        >
                          {({ getFieldValue }) =>
                            getFieldValue("usageTemplateType") !== "custom" ? (
                              <div className="space-y-4">
                                <Form.Item
                                  name="usageBaseUrl"
                                  label={
                                    <span className="text-slate-700">
                                      Base URL
                                    </span>
                                  }
                                  rules={[
                                    {
                                      required: usageEnabled,
                                      message: "Base URL is required",
                                    },
                                  ]}
                                  className="mb-0"
                                >
                                  <Input
                                    placeholder="https://api.example.com"
                                    size="large"
                                  />
                                </Form.Item>
                                <Form.Item
                                  name="usageAccessToken"
                                  label={
                                    <span className="text-slate-700">
                                      Access Token
                                    </span>
                                  }
                                  rules={[
                                    {
                                      required: usageEnabled,
                                      message: "Access Token is required",
                                    },
                                  ]}
                                  className="mb-0"
                                >
                                  <Input.Password
                                    placeholder="your-access-token"
                                    size="large"
                                  />
                                </Form.Item>
                                <Form.Item
                                  name="usageUserId"
                                  label={
                                    <span className="text-slate-700">
                                      User ID
                                    </span>
                                  }
                                  className="mb-0"
                                >
                                  <Input placeholder="114514" size="large" />
                                </Form.Item>
                              </div>
                            ) : (
                              <Form.Item
                                name="usageCustomScript"
                                label={
                                  <span className="text-slate-700">
                                    {t("自定义脚本", "Custom Script", language)}
                                  </span>
                                }
                                className="mb-0"
                              >
                                <Input.TextArea
                                  rows={10}
                                  className="font-mono text-sm"
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
                  </div>
                ),
              },
            ]}
          />
        </Form>
      </div>
    </Drawer>
  );
}
