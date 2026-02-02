import { useEffect, useState } from "react";
import { Typography, Button, Row, Col, Spin, message, theme, Card } from "antd";
import { PlusOutlined, CloudServerOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useProviderStore } from "../stores/providerStore";
import ProviderCard from "../components/providers/ProviderCard";
import ProviderModal from "../components/providers/ProviderModal";
import type { Provider, CreateProviderInput } from "@shared/types";

const { Title, Text } = Typography;

export default function Providers() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const {
    providers,
    loading,
    fetchProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    refreshBalance,
  } = useProviderStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setModalOpen(true);
  };

  const handleCreate = () => {
    setEditingProvider(null);
    setModalOpen(true);
  };

  const handleSave = async (
    input: CreateProviderInput & { id?: string; isActive?: boolean },
  ) => {
    if (input.id) {
      await updateProvider({ ...input, id: input.id });
    } else {
      await createProvider(input);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProvider(id);
      message.success(t("providers.providerDeleted"));
    } catch (error) {
      message.error(t("providers.deleteProviderFailed"));
    }
  };

  const handleRefreshBalance = async (id: string) => {
    setRefreshingIds((prev) => new Set(prev).add(id));
    try {
      const result = await refreshBalance(id);
      if (result.error) {
        message.error(result.error);
      } else {
        message.success(
          `${t("providers.balance")}: $${result.balance?.toFixed(2)}`,
        );
      }
    } catch (error) {
      message.error(t("providers.refreshBalanceFailed"));
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Title level={3} className="!m-0 !mb-1">
            {t("providers.title")}
          </Title>
          <Text type="secondary">{t("providers.subtitle")}</Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleCreate}
          size="large"
        >
          {t("providers.addProvider")}
        </Button>
      </div>

      {loading ? (
        <div className="empty-state">
          <Spin size="large" />
        </div>
      ) : providers.length === 0 ? (
        <Card className="empty-state" variant="outlined">
          <CloudServerOutlined
            className="text-5xl mb-4"
            style={{ color: token.colorTextSecondary }}
          />
          <Title level={4} className="!mb-2">
            {t("providers.noProviders")}
          </Title>
          <Text type="secondary" className="block mb-6">
            {t("providers.noProvidersHint")}
          </Text>
          <Button type="primary" size="large" onClick={handleCreate}>
            {t("providers.addFirstProvider")}
          </Button>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {providers.map((provider) => (
            <Col key={provider.id} xs={24} sm={24} md={12} lg={8} xl={8}>
              <ProviderCard
                provider={provider}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onRefreshBalance={handleRefreshBalance}
                refreshing={refreshingIds.has(provider.id)}
              />
            </Col>
          ))}
        </Row>
      )}

      <ProviderModal
        open={modalOpen}
        provider={editingProvider}
        onClose={() => {
          setModalOpen(false);
          setEditingProvider(null);
        }}
        onSave={handleSave}
      />
    </div>
  );
}
