import { useEffect, useState } from "react";
import { Typography, Card, Divider, message, Badge, Space, theme } from "antd";
import { ApiOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import DropZone from "../components/dashboard/DropZone";
import RecentProjects from "../components/dashboard/RecentProjects";
import NewProjectModal from "../components/dashboard/NewProjectModal";
import { useProjectStore } from "../stores/projectStore";
import { useProviderStore } from "../stores/providerStore";
import type { Project } from "@shared/types";

const { Title, Text } = Typography;

export default function Dashboard() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const {
    projects,
    fetchProjects,
    createProject,
    deleteProject,
    getProjectByPath,
  } = useProjectStore();
  const { providers, fetchProviders } = useProviderStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [droppedPath, setDroppedPath] = useState("");
  const [proxyStatus, setProxyStatus] = useState<{
    isRunning: boolean;
    port: number;
  }>({
    isRunning: false,
    port: 12345,
  });

  useEffect(() => {
    fetchProjects();
    fetchProviders();
    checkProxyStatus();
  }, [fetchProjects, fetchProviders]);

  const checkProxyStatus = async () => {
    try {
      const status = await window.api.proxy.status();
      setProxyStatus(status);
    } catch {
      // Proxy not available yet
    }
  };

  const handleDrop = async (path: string) => {
    try {
      const existingProject = await getProjectByPath(path);

      if (existingProject) {
        // Project exists, launch terminal directly
        await window.api.terminal.launch(existingProject.id);
        message.success(`${t("projects.opened")} ${existingProject.name}`);
        fetchProjects(); // Refresh to update lastOpenedAt
      } else {
        // Project doesn't exist, show modal
        setDroppedPath(path);
        setModalOpen(true);
      }
    } catch (error) {
      message.error(t("messages.processFolderFailed"));
    }
  };

  const handleCreateProject = async (name: string, providerId: string) => {
    try {
      const project = await createProject({
        name,
        path: droppedPath,
        providerId,
      });
      await window.api.terminal.launch(project.id);
      message.success(`${t("newProject.createdAndOpened")} ${name}`);
    } catch (error) {
      throw error;
    }
  };

  const handleOpenProject = async (project: Project) => {
    try {
      await window.api.terminal.launch(project.id);
      message.success(`${t("projects.opened")} ${project.name}`);
      fetchProjects(); // Refresh to update lastOpenedAt
    } catch (error) {
      message.error(t("projects.openFailed"));
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await deleteProject(id);
      message.success(t("messages.projectRemoved"));
    } catch (error) {
      message.error(t("messages.removeProjectFailed"));
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Title level={3} className="!m-0 !mb-1">
            {t("dashboard.title")}
          </Title>
          <Text type="secondary">{t("dashboard.subtitle")}</Text>
        </div>
        <Card
          size="small"
          style={{
            background: proxyStatus.isRunning
              ? token.colorSuccessBg
              : token.colorBgContainer,
            border: `1px solid ${proxyStatus.isRunning ? token.colorSuccessBorder : token.colorBorder}`,
          }}
        >
          <Space>
            <Badge status={proxyStatus.isRunning ? "success" : "default"} />
            <Text
              style={{
                color: proxyStatus.isRunning
                  ? token.colorSuccess
                  : token.colorTextSecondary,
              }}
            >
              <ApiOutlined /> {t("dashboard.proxy")}:{" "}
              {proxyStatus.isRunning
                ? `${t("dashboard.proxyRunning")} :${proxyStatus.port}`
                : t("dashboard.proxyStopped")}
            </Text>
          </Space>
        </Card>
      </div>

      <Card className="mb-6" variant="outlined">
        <DropZone onDrop={handleDrop} />
      </Card>

      <Divider orientationMargin={0} style={{ borderColor: token.colorPrimary }}>
        <Space>
          <ThunderboltOutlined style={{ color: token.colorPrimary }} />
          {t("dashboard.recentProjects")}
        </Space>
      </Divider>

      <RecentProjects
        projects={projects.slice(0, 10)}
        onOpen={handleOpenProject}
        onDelete={handleDeleteProject}
      />

      <NewProjectModal
        open={modalOpen}
        path={droppedPath}
        providers={providers}
        onClose={() => {
          setModalOpen(false);
          setDroppedPath("");
        }}
        onSave={handleCreateProject}
      />
    </div>
  );
}
