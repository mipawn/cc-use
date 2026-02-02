import { useState, useCallback } from "react";
import { Typography, message } from "antd";
import { FolderOpenOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import styles from "./DropZone.module.css";

const { Text } = Typography;

interface DropZoneProps {
  onDrop: (path: string) => void;
}

export default function DropZone({ onDrop }: DropZoneProps) {
  const { t } = useTranslation();
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
      className={clsx(styles.dropZone, isDragging && styles.dropZoneDragging)}
    >
      <FolderOpenOutlined className={styles.dropZoneIcon} />
      <div>
        <Text className={styles.dropZoneTitle}>
          {t("dashboard.dropZone")}
        </Text>
      </div>
      <div className={styles.dropZoneHint}>
        <Text type="secondary">{t("dashboard.dropZoneHint")}</Text>
      </div>
    </div>
  );
}
