import { useMemo } from "react";
import { Segmented } from "antd";
import { AppstoreOutlined, GlobalOutlined } from "@ant-design/icons";
import type { CLIType } from "../api/client";
import { useUIStore, t } from "../stores/ui";
import ClaudeIcon from "../assets/claude-icon.svg";
import CodexIcon from "../assets/codex-icon.svg";

type ValueType = "all" | "_global" | CLIType;

interface ProviderTypeSegmentedProps {
  value: ValueType;
  onChange: (value: ValueType) => void;
  /** 显示"全部"选项（用于筛选） */
  showAll?: boolean;
  /** 显示"全局"选项（用于通用配置） */
  showGlobal?: boolean;
  disabled?: boolean;
  size?: "default" | "small";
}

export default function ProviderTypeSegmented({
  value,
  onChange,
  showAll = false,
  showGlobal = false,
  disabled = false,
  size = "default",
}: ProviderTypeSegmentedProps) {
  const { language } = useUIStore();

  const options = useMemo(() => {
    const baseOptions = [
      {
        value: "claude" as const,
        label: (
          <div className="flex items-center gap-1.5">
            <img src={ClaudeIcon} alt="Claude" className="w-4 h-4" />
            <span>Claude</span>
          </div>
        ),
      },
      {
        value: "codex" as const,
        label: (
          <div className="flex items-center gap-1.5">
            <img src={CodexIcon} alt="Codex" className="w-4 h-4" />
            <span>Codex</span>
          </div>
        ),
      },
    ];

    if (showAll) {
      return [
        {
          value: "all" as const,
          label: (
            <div className="flex items-center gap-1.5">
              <AppstoreOutlined className="text-sm" />
              <span>{t("全部", "All", language)}</span>
            </div>
          ),
        },
        ...baseOptions,
      ];
    }

    if (showGlobal) {
      return [
        {
          value: "_global" as const,
          label: (
            <div className="flex items-center gap-1.5">
              <GlobalOutlined className="text-sm" />
              <span>{t("全局", "Global", language)}</span>
            </div>
          ),
        },
        ...baseOptions,
      ];
    }

    return baseOptions;
  }, [language, showAll, showGlobal]);

  return (
    <Segmented
      options={options}
      value={value}
      onChange={onChange as (value: string | number) => void}
      disabled={disabled}
      className={size === "small" ? "type-tabs-segmented-sm" : "type-tabs-segmented"}
    />
  );
}
