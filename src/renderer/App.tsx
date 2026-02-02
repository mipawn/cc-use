import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout, theme } from "antd";
import Sidebar from "./components/layout/Sidebar";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Projects from "./pages/Projects";
import Settings from "./pages/Settings";
import { useAntdTokenSync } from "./hooks/useAntdTokenSync";

const { Content } = Layout;

function AppContent() {
  const { token } = theme.useToken();
  useAntdTokenSync();

  return (
    <Layout className="min-h-screen">
      <Sidebar />
      <Layout style={{ background: token.colorBgLayout }}>
        <Content style={{ padding: 24, overflow: "auto" }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
