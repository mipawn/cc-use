import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout, theme } from "antd";
import Sidebar from "./components/layout/Sidebar";
import Dashboard from "./pages/Dashboard";
import Keys from "./pages/Keys";
import Projects from "./pages/Projects";
import Statistics from "./pages/Statistics";
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
        <Content style={{ padding: 24, overflow: 'hidden', height: '100vh', display: 'flex', flexDirection: 'column' }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/keys" element={<Keys />} />
            <Route path="/providers" element={<Keys />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/statistics" element={<Statistics />} />
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
