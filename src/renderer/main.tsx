import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, theme, App as AntdApp } from "antd";
import { StyleProvider } from "@ant-design/cssinjs";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import App from "./App";
import { useSettingsStore } from "./stores/settingsStore";
import "./locales";
import "./styles/global.css";

function Root() {
  const { language, resolvedTheme, initSettings } = useSettingsStore();

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  return (
    <StyleProvider layer>
      <ConfigProvider
        locale={language === "zh" ? zhCN : enUS}
        theme={{
          algorithm:
            resolvedTheme === "dark"
              ? theme.darkAlgorithm
              : theme.defaultAlgorithm,
          token: {
            colorPrimary: "#1677ff",
            borderRadius: 8,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'",
          },
          components: {
            Layout: {
              bodyBg: resolvedTheme === "dark" ? "#141414" : "#f5f5f5",
              headerBg: resolvedTheme === "dark" ? "#1f1f1f" : "#ffffff",
              siderBg: resolvedTheme === "dark" ? "#1f1f1f" : "#ffffff",
            },
            Card: {
              colorBgContainer:
                resolvedTheme === "dark" ? "#1f1f1f" : "#ffffff",
            },
          },
        }}
      >
        <AntdApp message={{ maxCount: 3, top: 60 }}>
          <App />
        </AntdApp>
      </ConfigProvider>
    </StyleProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
