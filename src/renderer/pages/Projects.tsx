import { useEffect } from "react";
import {
  Typography,
  List,
  Button,
  Popconfirm,
  Tag,
  message,
  theme,
  Card,
} from "antd";
import {
  FolderOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../stores/projectStore";
import { useProviderStore } from "../stores/providerStore";
import type { Project } from "@shared/types";

const { Title, Text } = Typography;

export default function Projects() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { projects, fetchProjects, deleteProject } = useProjectStore();
  const { providers, fetchProviders } = useProviderStore();

  useEffect(() => {
    fetchProjects();
    fetchProviders();
  }, [fetchProjects, fetchProviders]);

  const getProviderName = (providerId: string | null) => {
    if (!providerId) return t("projects.noProvider");
    const provider = providers.find((p) => p.id === providerId);
    return provider?.name || t("common.unknown");
  };

  const formatDate = (timestamp: string | null) => {
    if (!timestamp) return t("common.never");
    const date = new Date(timestamp);
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  };

  const handleOpen = async (project: Project) => {
    try {
      await window.api.terminal.launch(project.id);
      message.success(`${t("projects.opened")} ${project.name}`);
      fetchProjects();
    } catch (error) {
      message.error(t("projects.openFailed"));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id);
      message.success(t("projects.projectDeleted"));
    } catch (error) {
      message.error(t("projects.deleteProjectFailed"));
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Title level={3} className="!m-0 !mb-1">
            {t("projects.title")}
          </Title>
          <Text type="secondary">{t("projects.subtitle")}</Text>
        </div>
      </div>

      {projects.length === 0 ? (
        <Card className="empty-state" variant="outlined">
          <FolderOutlined
            className="text-5xl mb-4"
            style={{ color: token.colorTextSecondary }}
          />
          <Title level={4} className="!mb-2">
            {t("projects.noProjects")}
          </Title>
          <Text type="secondary">{t("projects.dropFolderHint")}</Text>
        </Card>
      ) : (
        <Card variant="outlined">
          <List
            dataSource={projects}
            renderItem={(project) => (
              <List.Item
                className="py-4"
                style={{
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
                actions={[
                  <Button
                    key="open"
                    type="primary"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={() => handleOpen(project)}
                    className="rounded-md"
                  >
                    {t("common.open")}
                  </Button>,
                  <Popconfirm
                    key="delete"
                    title={t("projects.deleteProject")}
                    description={t("projects.deleteProjectHint")}
                    onConfirm={() => handleDelete(project.id)}
                    okText={t("common.delete")}
                    cancelText={t("common.cancel")}
                    okButtonProps={{ danger: true }}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <div
                      className="icon-box"
                      style={{ background: token.colorPrimaryBg }}
                    >
                      <FolderOutlined
                        className="text-xl"
                        style={{ color: token.colorPrimary }}
                      />
                    </div>
                  }
                  title={
                    <span>
                      {project.name}{" "}
                      <Tag color="green" className="ml-2">
                        {getProviderName(project.providerId)}
                      </Tag>
                    </span>
                  }
                  description={
                    <div>
                      <Text type="secondary" className="text-xs">
                        {project.path}
                      </Text>
                      <br />
                      <Text type="secondary" className="text-xs">
                        {t("projects.lastOpened")}:{" "}
                        {formatDate(project.lastOpenedAt)}
                      </Text>
                    </div>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
}
