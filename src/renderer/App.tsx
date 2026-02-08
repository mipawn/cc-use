import { HashRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Layout, theme, App as AntdApp, Alert, Button } from "antd";
import { useState, useEffect } from "react";
import Sidebar from "./components/layout/Sidebar";
import Dashboard from "./pages/Dashboard";
import Keys from "./pages/Keys";
import Projects from "./pages/Projects";
import Statistics from "./pages/Statistics";
import Settings from "./pages/Settings";
import { useAntdTokenSync } from "./hooks/useAntdTokenSync";
import { setGlobalMessage } from "./hooks/useAppMessage";
import { useTranslation } from "react-i18next";
import type { UpdateCheckResult } from "@shared/types";

const { Content } = Layout;

function UpdateBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    const unsubscribe = window.api.app.onUpdateAvailable((result: UpdateCheckResult) => {
      setUpdateInfo(result);
    });
    return () => unsubscribe();
  }, []);

  if (!updateInfo) return null;

  return (
    <Alert
      message={t('settings.newVersionAvailable')}
      description={t('settings.newVersionDesc', { version: updateInfo.latestVersion })}
      type="info"
      showIcon
      closable
      onClose={() => setUpdateInfo(null)}
      action={
        <Button size="small" type="primary" onClick={() => {
          navigate('/settings');
          setUpdateInfo(null);
        }}>
          {t('settings.goToDownload')}
        </Button>
      }
      style={{ marginBottom: 16 }}
    />
  );
}

function AppContent() {
  const { token } = theme.useToken();
  const { message } = AntdApp.useApp();
  useAntdTokenSync();

  // Initialize global message reference for non-component code
  setGlobalMessage(message);

  return (
    <Layout className="min-h-screen">
      <Sidebar />
      <Layout style={{ background: token.colorBgLayout }}>
        <Content style={{ padding: 24, overflow: 'hidden', height: '100vh', display: 'flex', flexDirection: 'column' }}>
          <UpdateBanner />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/keys" element={<Keys />} />
            <Route path="/providers" element={<Keys />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}
