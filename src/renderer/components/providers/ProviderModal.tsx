import { useEffect, useState, useRef } from "react";
import {
  Modal,
  Form,
  Input,
  Select,
  Divider,
  Typography,
  message,
  Tabs,
  Segmented,
  Tooltip,
} from "antd";
import { UploadOutlined, LinkOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { Provider, CreateProviderInput } from "@shared/types";
import { useSettingsStore } from "../../stores/settingsStore";
import ApiKeyList from "../apiKeys/ApiKeyList";

import claudeIcon from "../../assets/provider-icons/claude.svg";
import openaiIcon from "../../assets/provider-icons/openai.svg";
import zhipuIcon from "../../assets/provider-icons/zhipu.svg";
import minimaxIcon from "../../assets/provider-icons/minimax.svg";
import deepseekIcon from "../../assets/provider-icons/deepseek.svg";
import siliconflowIcon from "../../assets/provider-icons/siliconflow.svg";
import newapiIcon from "../../assets/provider-icons/newapi.svg";

const { Title, Text } = Typography;
const { TextArea } = Input;

const PRESET_ICONS: { key: string; icon: string; label: string }[] = [
  { key: "claude", icon: claudeIcon, label: "Claude" },
  { key: "openai", icon: openaiIcon, label: "OpenAI" },
  { key: "deepseek", icon: deepseekIcon, label: "DeepSeek" },
  { key: "zhipu", icon: zhipuIcon, label: "智谱" },
  { key: "minimax", icon: minimaxIcon, label: "MiniMax" },
  { key: "siliconflow", icon: siliconflowIcon, label: "硅基流动" },
  { key: "newapi", icon: newapiIcon, label: "NewAPI" },
];

const PRESET_ICON_MAP: Record<string, string> = Object.fromEntries(
  PRESET_ICONS.map((i) => [i.key, i.icon])
);

interface ProviderModalProps {
  open: boolean;
  provider: Provider | null;
  onClose: () => void;
  onSave: (
    input: CreateProviderInput & { id?: string; isActive?: boolean },
  ) => Promise<void>;
}

export default function ProviderModal({
  open,
  provider,
  onClose,
  onSave,
}: ProviderModalProps) {
  const { t } = useTranslation();
  const { globalSettings } = useSettingsStore();
  const [form] = Form.useForm();
  const [balanceForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [balanceType, setBalanceType] = useState<"none" | "newapi" | "custom">("none");
  const [activeTab, setActiveTab] = useState("basic");
  const [jsonValue, setJsonValue] = useState("");
  const [selectedIcon, setSelectedIcon] = useState<string>("claude");
  const [customIconPath, setCustomIconPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setActiveTab("basic");
      if (provider) {
        form.setFieldsValue({
          name: provider.name,
          baseUrl: provider.baseUrl,
          type: provider.type,
          website: provider.website,
          remark: provider.remark,
          token: provider.token,
        });
        balanceForm.setFieldsValue({
          walletBalanceType: provider.walletBalanceType,
          walletBalanceUrl: provider.walletBalanceUrl,
          walletBalancePath: provider.walletBalancePath,
          walletBalanceHeaders: provider.walletBalanceHeaders,
        });
        setBalanceType(provider.walletBalanceType);
        if (provider.icon) {
          if (PRESET_ICON_MAP[provider.icon]) {
            setSelectedIcon(provider.icon);
            setCustomIconPath(null);
          } else {
            setSelectedIcon("custom");
            setCustomIconPath(provider.icon);
          }
        } else {
          setSelectedIcon(provider.type === "codex" ? "openai" : "claude");
          setCustomIconPath(null);
        }
        setJsonValue(JSON.stringify({
          baseUrl: provider.baseUrl || "",
          token: provider.token || "",
        }, null, 2));
      } else {
        form.resetFields();
        balanceForm.resetFields();
        setBalanceType("none");
        setSelectedIcon("claude");
        setCustomIconPath(null);
        setJsonValue(JSON.stringify({
          baseUrl: "",
          token: "",
        }, null, 2));
      }
    }
  }, [open, provider, form, balanceForm]);

  const syncJsonToForm = (json: string) => {
    try {
      const parsed = JSON.parse(json);
      if (parsed.baseUrl !== undefined) {
        form.setFieldValue("baseUrl", parsed.baseUrl);
      }
      if (parsed.token !== undefined) {
        form.setFieldValue("token", parsed.token);
      }
    } catch {}
  };

  const syncFormToJson = () => {
    const baseUrl = form.getFieldValue("baseUrl") || "";
    const token = form.getFieldValue("token") || "";
    setJsonValue(JSON.stringify({ baseUrl, token }, null, 2));
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);

      const values = await form.validateFields();
      const balanceValues = await balanceForm.validateFields();
      const iconValue = selectedIcon === "custom" ? customIconPath : selectedIcon;

      await onSave({
        id: provider?.id,
        name: values.name,
        baseUrl: values.baseUrl,
        type: values.type,
        website: values.website,
        remark: values.remark,
        token: values.token,
        icon: iconValue || undefined,
        walletBalanceType: balanceValues.walletBalanceType,
        walletBalanceUrl: balanceValues.walletBalanceUrl,
        walletBalancePath: balanceValues.walletBalancePath,
        walletBalanceHeaders: balanceValues.walletBalanceHeaders,
        isActive: provider?.isActive ?? true,
      });

      message.success(
        provider
          ? t("providers.providerUpdated")
          : t("providers.providerCreated"),
      );
      onClose();
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleIconUpload = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const path = await window.api.icon.upload(buffer, file.name);
      setCustomIconPath(path);
      setSelectedIcon("custom");
    } catch (error) {
      message.error(t("messages.error"));
    }
  };

  const renderIconSelector = () => {
    return (
      <div className="flex flex-wrap gap-2 items-center">
        {PRESET_ICONS.map((item) => (
          <Tooltip key={item.key} title={item.label}>
            <div
              className={`w-10 h-10 rounded-lg cursor-pointer flex items-center justify-center border-2 transition-all ${
                selectedIcon === item.key
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
              onClick={() => {
                setSelectedIcon(item.key);
                setCustomIconPath(null);
              }}
            >
              <img src={item.icon} alt={item.label} className="w-6 h-6" />
            </div>
          </Tooltip>
        ))}
        <Tooltip title={t("providers.uploadIcon")}>
          <div
            className={`w-10 h-10 rounded-lg cursor-pointer flex items-center justify-center border-2 transition-all ${
              selectedIcon === "custom"
                ? "border-blue-500 bg-blue-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            {customIconPath ? (
              <img src={`file://${customIconPath}`} alt="custom" className="w-6 h-6 object-cover rounded" />
            ) : (
              <UploadOutlined className="text-gray-400" />
            )}
          </div>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleIconUpload(file);
          }}
        />
      </div>
    );
  };

  const getMergedConfig = () => {
    const formValues = form.getFieldsValue();
    const balanceValues = balanceForm.getFieldsValue();
    const iconValue = selectedIcon === "custom" ? customIconPath : selectedIcon;

    return {
      global: {
        defaultProviderType: globalSettings.defaultProviderType,
        proxyPort: globalSettings.proxyPort,
        autoStartProxy: globalSettings.autoStartProxy,
      },
      provider: {
        name: formValues.name || "",
        baseUrl: formValues.baseUrl || "",
        type: formValues.type || globalSettings.defaultProviderType,
        website: formValues.website || "",
        remark: formValues.remark || "",
        token: formValues.token || "",
        icon: iconValue || "",
        walletBalanceType: balanceValues.walletBalanceType || "none",
        walletBalanceUrl: balanceValues.walletBalanceUrl || "",
        walletBalancePath: balanceValues.walletBalancePath || "",
        walletBalanceHeaders: balanceValues.walletBalanceHeaders || "",
      },
      merged: {
        proxyUrl: `http://localhost:${globalSettings.proxyPort}`,
        envVars: formValues.type === "codex" ? {
          OPENAI_BASE_URL: `http://localhost:${globalSettings.proxyPort}`,
          OPENAI_API_KEY: formValues.token || "(from API keys)",
        } : {
          ANTHROPIC_BASE_URL: `http://localhost:${globalSettings.proxyPort}`,
          ANTHROPIC_API_KEY: formValues.token || "(from API keys)",
        },
      },
    };
  };

  const basicContent = (
    <div className="flex gap-4">
      <div className="flex-1">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            type: globalSettings.defaultProviderType,
          }}
          onValuesChange={(changed) => {
            if (changed.baseUrl !== undefined || changed.token !== undefined) {
              syncFormToJson();
            }
          }}
        >
          <Form.Item name="type" label={t("providers.type")}>
            <Segmented
              options={[
                { value: "claude", label: t("providers.typeClaude") },
                { value: "codex", label: t("providers.typeCodex") },
              ]}
              onChange={(value) => {
                if (!provider && !customIconPath) {
                  setSelectedIcon(value === "codex" ? "openai" : "claude");
                }
              }}
            />
          </Form.Item>

          <Form.Item
            name="name"
            label={t("common.name")}
            rules={[{ required: true, message: t("providers.enterName") }]}
          >
            <Input placeholder={t("providers.namePlaceholder")} />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label={t("providers.baseUrl")}
            rules={[
              { required: true, message: t("providers.enterBaseUrl") },
              { type: "url", message: t("providers.invalidUrl") },
            ]}
          >
            <Input placeholder={t("providers.baseUrlPlaceholder")} />
          </Form.Item>

          <Form.Item name="token" label={t("providers.token")}>
            <Input.Password placeholder={t("providers.tokenPlaceholder")} />
          </Form.Item>

          <Form.Item label={t("providers.icon")}>
            {renderIconSelector()}
          </Form.Item>

          <Form.Item name="website" label={t("providers.website")}>
            <Input
              placeholder={t("providers.websitePlaceholder")}
              prefix={<LinkOutlined className="text-gray-400" />}
            />
          </Form.Item>

          <Form.Item name="remark" label={t("providers.remark")}>
            <TextArea rows={2} placeholder={t("providers.remarkPlaceholder")} />
          </Form.Item>
        </Form>
      </div>

      <div className="w-64 border-l pl-4">
        <Text type="secondary" className="block mb-2 text-xs">
          {t("providers.jsonSyncHint")}
        </Text>
        <TextArea
          rows={10}
          value={jsonValue}
          onChange={(e) => {
            setJsonValue(e.target.value);
            syncJsonToForm(e.target.value);
          }}
          placeholder={`{
  "baseUrl": "",
  "token": ""
}`}
          className="font-mono text-xs"
        />
      </div>
    </div>
  );

  const balanceContent = (
    <Form
      form={balanceForm}
      layout="vertical"
      initialValues={{
        walletBalanceType: "none",
      }}
    >
      <Form.Item name="walletBalanceType" label={t("providers.balanceType")}>
        <Select
          onChange={(value) => setBalanceType(value)}
          options={[
            { value: "none", label: t("providers.balanceTypeNone") },
            { value: "newapi", label: t("providers.balanceTypeNewapi") },
            { value: "custom", label: t("providers.balanceTypeCustom") },
          ]}
        />
      </Form.Item>

      {balanceType === "newapi" && (
        <Text type="secondary" className="block mb-4">
          {t("providers.newapiHint")}
        </Text>
      )}

      {balanceType === "custom" && (
        <>
          <Form.Item
            name="walletBalanceUrl"
            label={t("providers.balanceUrl")}
            rules={[
              {
                required: balanceType === "custom",
                message: t("providers.enterBalanceUrl"),
              },
            ]}
          >
            <Input placeholder="https://api.example.com/balance" />
          </Form.Item>

          <Form.Item
            name="walletBalancePath"
            label={t("providers.balancePath")}
            rules={[
              {
                required: balanceType === "custom",
                message: t("providers.enterBalancePath"),
              },
            ]}
            extra={t("providers.balancePathHint")}
          >
            <Input placeholder="data.balance" />
          </Form.Item>

          <Form.Item
            name="walletBalanceHeaders"
            label={t("providers.customHeaders")}
            extra={t("providers.curlHint")}
          >
            <TextArea
              rows={4}
              placeholder={`curl -X GET "https://api.example.com/balance" \\
  -H "Authorization: Bearer YOUR_TOKEN"`}
              className="font-mono text-xs"
            />
          </Form.Item>
        </>
      )}
    </Form>
  );

  const previewContent = () => {
    const config = getMergedConfig();
    return (
      <div className="space-y-4">
        <div>
          <Title level={5} className="!mb-2">{t("providers.previewGlobal")}</Title>
          <pre className="bg-gray-50 p-3 rounded text-xs overflow-auto">
            {JSON.stringify(config.global, null, 2)}
          </pre>
        </div>

        <div>
          <Title level={5} className="!mb-2">{t("providers.previewProvider")}</Title>
          <pre className="bg-gray-50 p-3 rounded text-xs overflow-auto">
            {JSON.stringify(config.provider, null, 2)}
          </pre>
        </div>

        <div>
          <Title level={5} className="!mb-2">{t("providers.previewEnv")}</Title>
          <pre className="bg-blue-50 p-3 rounded text-xs overflow-auto">
            {Object.entries(config.merged.envVars).map(([k, v]) => `${k}=${v}`).join("\n")}
          </pre>
        </div>
      </div>
    );
  };

  return (
    <Modal
      title={provider ? t("providers.editProvider") : t("providers.newProvider")}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t("common.confirm")}
      cancelText={t("common.cancel")}
      confirmLoading={loading}
      width={800}
      destroyOnHidden
      styles={{
        body: {
          maxHeight: "calc(100vh - 200px)",
          overflowY: "auto",
        },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "basic",
            label: t("providers.basicConfig"),
            children: basicContent,
          },
          {
            key: "balance",
            label: t("providers.balanceConfig"),
            children: balanceContent,
          },
          {
            key: "preview",
            label: t("providers.preview"),
            children: previewContent(),
          },
        ]}
      />

      {provider && (
        <>
          <Divider />
          <Title level={5}>{t("providers.apiKeys")}</Title>
          <ApiKeyList providerId={provider.id} />
        </>
      )}
    </Modal>
  );
}
