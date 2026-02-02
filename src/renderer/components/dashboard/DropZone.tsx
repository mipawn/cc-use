import { useState, useCallback } from "react";
import { Typography, message, theme } from "antd";
import { FolderOpenOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

const { Text } = Typography;

interface DropZoneProps {
  onDrop: (path: string) => void;
}

export default function DropZone({ onDrop }: DropZoneProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length === 0) {
        message.error(t("dropZone.noFilesDropped"));
        return;
      }

      const file = files[0];
      // In Electron, we can get the path from the file object
      const path = (file as File & { path?: string }).path;

      if (!path) {
        message.error(t("dropZone.couldNotGetPath"));
        return;
      }

      onDrop(path);
    },
    [onDrop, t],
  );

  const handleClick = async () => {
    try {
      const path = await window.api.system.selectFolder();
      if (path) {
        onDrop(path);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
      message.error(t("dropZone.couldNotGetPath"));
    }
  };

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        border: `2px dashed ${token.colorBorder}`,
        borderRadius: 12,
        padding: 48,
        textAlign: "center",
        cursor: "pointer",
        transition: "all 0.3s",
        backgroundColor: isDragging ? token.colorFillSecondary : "transparent",
      }}
    >
      <FolderOpenOutlined
        style={{
          fontSize: 64,
          color: token.colorTextQuaternary,
          marginBottom: 16,
        }}
      />
      <div>
        <Text
          style={{
            fontSize: 18,
            color: token.colorText,
          }}
        >
          {t("dashboard.dropZone")}
        </Text>
      </div>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary">{t("dashboard.dropZoneHint")}</Text>
      </div>
    </div>
  );
}
