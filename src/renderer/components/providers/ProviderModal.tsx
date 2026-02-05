import { useEffect, useState, useRef } from "react";
import {
  Modal,
  Form,
  Input,
  Select,
  Typography,
  message,
  Tooltip,
  Space,
  Collapse,
} from "antd";
import {
  UploadOutlined,
  LinkOutlined,
  SettingOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import SimpleBar from "simplebar-react";
import type { Provider, CreateProviderInput } from "@shared/types";
import styles from "./ProviderModal.module.css";

import claudeIcon from "../../assets/provider-icons/claude.svg";
import openaiIcon from "../../assets/provider-icons/openai.svg";
import zhipuIcon from "../../assets/provider-icons/zhipu.svg";
import minimaxIcon from "../../assets/provider-icons/minimax.svg";
import deepseekIcon from "../../assets/provider-icons/deepseek.svg";
import siliconflowIcon from "../../assets/provider-icons/siliconflow.svg";
import newapiIcon from "../../assets/provider-icons/newapi.svg";

const { Text } = Typography;
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
  PRESET_ICONS.map((i) => [i.key, i.icon]),
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
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [balanceType, setBalanceType] = useState<"none" | "newapi" | "custom">(
    "none",
  );
  const [selectedIcon, setSelectedIcon] = useState<string>("claude");
  const [customIconPath, setCustomIconPath] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      if (provider) {
        form.setFieldsValue({
          name: provider.name,
          baseUrl: provider.baseUrl,
          type: provider.type,
          website: provider.website,
          remark: provider.remark,
          token: provider.token,
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
        // Show advanced if there's balance config
        setShowAdvanced(provider.walletBalanceType !== "none");
      } else {
        form.resetFields();
        form.setFieldsValue({
          walletBalanceType: "none",
        });
        setBalanceType("none");
        setSelectedIcon("claude");
        setCustomIconPath(null);
        setShowAdvanced(false);
      }
    }
  }, [open, provider, form]);

  const handleSubmit = async () => {
    try {
      setLoading(true);
      const values = await form.validateFields();
      const iconValue =
        selectedIcon === "custom" ? customIconPath : selectedIcon;

      await onSave({
        id: provider?.id,
        name: values.name,
        baseUrl: values.baseUrl,
        website: values.website,
        remark: values.remark,
        token: values.token,
        icon: iconValue || undefined,
        walletBalanceType: values.walletBalanceType,
        walletBalanceUrl: values.walletBalanceUrl,
        walletBalancePath: values.walletBalancePath,
        walletBalanceHeaders: values.walletBalanceHeaders,
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

  return (
    <Modal
      title={
        provider
          ? t("providers.editProvider")
          : t("providers.newProvider")
      }
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t("common.confirm")}
      cancelText={t("common.cancel")}
      confirmLoading={loading}
      width={720}
      destroyOnHidden
      className={styles.modal}
    >
      <SimpleBar className={styles.scrollContainer}>
        <div className={styles.body}>
        <Form
          form={form}
          layout="vertical"
          className={styles.form}
          initialValues={{
            walletBalanceType: "none",
          }}
        >
          {/* Main Form Grid */}
          <div className={styles.formGrid}>
            {/* Left Column - Basic Info */}
            <div className={styles.formColumn}>
              <div className={styles.sectionHeader}>
                <SettingOutlined className={styles.sectionIcon} />
                <Text strong>{t("providers.basicConfig")}</Text>
              </div>

              <Form.Item
                name="name"
                label={t("common.name")}
                rules={[{ required: true, message: t("providers.enterName") }]}
              >
                <Input
                  placeholder={t("providers.namePlaceholder")}
                  size="large"
                  className={styles.input}
                />
              </Form.Item>

              <Form.Item
                name="baseUrl"
                label={t("providers.baseUrl")}
                rules={[
                  { required: true, message: t("providers.enterBaseUrl") },
                  { type: "url", message: t("providers.invalidUrl") },
                ]}
              >
                <Input
                  placeholder={t("providers.baseUrlPlaceholder")}
                  size="large"
                  className={styles.input}
                />
              </Form.Item>

              <Form.Item name="token" label={t("providers.token")}>
                <Input.Password
                  placeholder={t("providers.tokenPlaceholder")}
                  size="large"
                  className={styles.input}
                />
              </Form.Item>

              {/* Icon Selector */}
              <Form.Item label={t("providers.icon")}>
                <div className={styles.iconGrid}>
                  {PRESET_ICONS.map((item) => (
                    <Tooltip key={item.key} title={item.label}>
                      <div
                        className={`${styles.iconItem} ${selectedIcon === item.key ? styles.iconItemActive : ""}`}
                        onClick={() => {
                          setSelectedIcon(item.key);
                          setCustomIconPath(null);
                        }}
                      >
                        <img
                          src={item.icon}
                          alt={item.label}
                          className={styles.iconImg}
                        />
                      </div>
                    </Tooltip>
                  ))}
                  <Tooltip title={t("providers.uploadIcon")}>
                    <div
                      className={`${styles.iconItem} ${selectedIcon === "custom" ? styles.iconItemActive : ""}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {customIconPath ? (
                        <img
                          src={`file://${customIconPath}`}
                          alt="custom"
                          className={styles.iconImg}
                        />
                      ) : (
                        <UploadOutlined className={styles.uploadIcon} />
                      )}
                    </div>
                  </Tooltip>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className={styles.hiddenInput}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleIconUpload(file);
                    }}
                  />
                </div>
              </Form.Item>
            </div>

            {/* Right Column - Additional Info */}
            <div className={styles.formColumn}>
              <div className={styles.sectionHeader}>
                <LinkOutlined className={styles.sectionIcon} />
                <Text strong>
                  {t("providers.additionalInfo") || "附加信息"}
                </Text>
              </div>

              <Form.Item name="website" label={t("providers.website")}>
                <Input
                  placeholder={t("providers.websitePlaceholder")}
                  prefix={<LinkOutlined className={styles.inputIcon} />}
                  size="large"
                  className={styles.input}
                />
              </Form.Item>

              <Form.Item name="remark" label={t("providers.remark")}>
                <TextArea
                  rows={5}
                  placeholder={t("providers.remarkPlaceholder")}
                  className={styles.textarea}
                />
              </Form.Item>
            </div>
          </div>

          {/* Advanced Settings - Collapsible */}
          <Collapse
            ghost
            activeKey={showAdvanced ? ["advanced"] : []}
            onChange={(keys) => setShowAdvanced(keys.includes("advanced"))}
            className={styles.advancedCollapse}
            items={[
              {
                key: "advanced",
                label: (
                  <Space>
                    <WalletOutlined />
                    <span>{t("providers.balanceConfig")}</span>
                  </Space>
                ),
                children: (
                  <div className={styles.advancedContent}>
                    <Form.Item
                      name="walletBalanceType"
                      label={t("providers.balanceType")}
                    >
                      <Select
                        onChange={(value) => setBalanceType(value)}
                        options={[
                          {
                            value: "none",
                            label: t("providers.balanceTypeNone"),
                          },
                          {
                            value: "newapi",
                            label: t("providers.balanceTypeNewapi"),
                          },
                          {
                            value: "custom",
                            label: t("providers.balanceTypeCustom"),
                          },
                        ]}
                      />
                    </Form.Item>

                    {balanceType === "newapi" && (
                      <div className={styles.hint}>
                        <Text type="secondary">
                          {t("providers.newapiHint")}
                        </Text>
                      </div>
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
                          <Input
                            placeholder="data.balance"
                            className={styles.monoInput}
                          />
                        </Form.Item>

                        <Form.Item
                          name="walletBalanceHeaders"
                          label={t("providers.customHeaders")}
                          extra={t("providers.curlHint")}
                        >
                          <TextArea
                            rows={3}
                            placeholder='{"Authorization": "Bearer YOUR_TOKEN"}'
                            className={styles.monoInput}
                          />
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
      </SimpleBar>
    </Modal>
  );
}
