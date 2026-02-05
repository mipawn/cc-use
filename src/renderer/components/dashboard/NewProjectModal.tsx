import { useState, useEffect, useMemo } from "react";
import {
  Modal,
  Form,
  Input,
  Select,
  Typography,
  Space,
  Tag,
  Divider,
} from "antd";
import {
  FolderOutlined,
  KeyOutlined,
  CloudServerOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { Provider, ApiKey } from "@shared/types";
import styles from "./NewProjectModal.module.css";

const { Text } = Typography;

interface NewProjectModalProps {
  open: boolean;
  path: string;
  providers: Provider[];
  apiKeys: ApiKey[];
  defaultProviderId?: string;
  defaultApiKeyId?: string;
  onClose: () => void;
  onSave: (
    name: string,
    providerId: string | undefined,
    apiKeyId: string | undefined,
  ) => Promise<void>;
}

export default function NewProjectModal({
  open,
  path,
  providers,
  apiKeys,
  defaultProviderId,
  defaultApiKeyId,
  onClose,
  onSave,
}: NewProjectModalProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<
    string | undefined
  >();

  const defaultName = path.split("/").pop() || t("newProject.myProject");

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        name: defaultName,
        providerId: defaultProviderId,
        apiKeyId: defaultApiKeyId,
      });
      setSelectedProviderId(defaultProviderId);
    }
  }, [open, form, defaultName, defaultProviderId, defaultApiKeyId]);

  // Filter API keys based on selected provider
  const filteredApiKeys = useMemo(() => {
    if (!selectedProviderId) {
      return apiKeys.filter((k) => k.isActive && !k.isExhausted);
    }
    return apiKeys.filter(
      (k) =>
        k.providerId === selectedProviderId && k.isActive && !k.isExhausted,
    );
  }, [apiKeys, selectedProviderId]);

  // Build provider options with key count
  const providerOptions = useMemo(() => {
    return providers
      .filter((p) => p.isActive)
      .map((p) => {
        const keyCount = apiKeys.filter(
          (k) => k.providerId === p.id && k.isActive && !k.isExhausted,
        ).length;
        return {
          value: p.id,
          label: (
            <Space>
              <span>{p.name}</span>
              <Tag
                color={keyCount > 0 ? "blue" : "default"}
                className={styles.keyCountTag}
              >
                {keyCount} keys
              </Tag>
            </Space>
          ),
          provider: p,
          keyCount,
        };
      });
  }, [providers, apiKeys]);

  // Build API key options grouped by provider
  const apiKeyOptions = useMemo(() => {
    if (selectedProviderId) {
      // If provider is selected, show only that provider's keys
      return filteredApiKeys.map((k) => ({
        value: k.id,
        label: k.alias || k.value.substring(0, 12) + "...",
      }));
    }

    // When no provider selected, show flat list of all keys
    return apiKeys
      .filter((k) => k.isActive && !k.isExhausted)
      .map((k) => {
        const provider = providers.find((p) => p.id === k.providerId);
        return {
          value: k.id,
          label: `${k.alias || k.value.substring(0, 12) + "..."} (${provider?.name || ""})`,
        };
      });
  }, [filteredApiKeys, providers, apiKeys, selectedProviderId]);

  const handleProviderChange = (providerId: string | undefined) => {
    setSelectedProviderId(providerId);
    // Clear API key selection when provider changes
    form.setFieldValue("apiKeyId", undefined);
  };

  const handleApiKeyChange = (apiKeyId: string | undefined) => {
    if (apiKeyId && !selectedProviderId) {
      // Auto-select provider when key is selected
      const key = apiKeys.find((k) => k.id === apiKeyId);
      if (key) {
        setSelectedProviderId(key.providerId);
        form.setFieldValue("providerId", key.providerId);
      }
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      await onSave(values.name, values.providerId, values.apiKeyId);
      form.resetFields();
      onClose();
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={null}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={loading}
      okText={t("common.confirm")}
      cancelText={t("common.cancel")}
      destroyOnHidden
      width={480}
      className={styles.modal}
    >
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <FolderOutlined />
        </div>
        <div className={styles.headerText}>
          <Text strong className={styles.headerTitle}>
            {t("newProject.title")}111
          </Text>
          <Text type="secondary" className={styles.headerPath}>
            {path}
          </Text>
        </div>
      </div>

      <Divider className={styles.divider} />

      <Form form={form} layout="vertical" className={styles.form}>
        <Form.Item
          name="name"
          label={t("projects.projectName")}
          rules={[{ required: true, message: t("newProject.enterName") }]}
        >
          <Input
            placeholder={t("newProject.myProject")}
            size="large"
            className={styles.input}
          />
        </Form.Item>

        <div className={styles.optionalSection}>
          <Text type="secondary" className={styles.optionalLabel}>
            {t("newProject.optionalConfig") || "可选配置"}
          </Text>
        </div>

        <Form.Item
          name="providerId"
          label={
            <Space>
              <CloudServerOutlined />
              <span>{t("common.providers")}</span>
            </Space>
          }
        >
          <Select
            placeholder={t("newProject.selectProviderPlaceholder")}
            allowClear
            size="large"
            options={providerOptions}
            onChange={handleProviderChange}
            className={styles.select}
          />
        </Form.Item>

        <Form.Item
          name="apiKeyId"
          label={
            <Space>
              <KeyOutlined />
              <span>{t("projects.selectApiKey")}</span>
            </Space>
          }
        >
          <Select
            placeholder={t("projects.selectApiKeyPlaceholder")}
            allowClear
            size="large"
            options={apiKeyOptions}
            onChange={handleApiKeyChange}
            className={styles.select}
            notFoundContent={
              <div className={styles.emptyKeys}>
                <Text type="secondary">
                  {selectedProviderId
                    ? t("apiKeys.noKeys")
                    : t("newProject.selectProviderFirst") ||
                      "请先选择供应商或直接选择密钥"}
                </Text>
              </div>
            }
          />
        </Form.Item>

        <div className={styles.hint}>
          <Text type="secondary" className={styles.hintText}>
            {t("newProject.bindingHint") || "不绑定时将使用默认的 API 密钥配置"}
          </Text>
        </div>
      </Form>
    </Modal>
  );
}
