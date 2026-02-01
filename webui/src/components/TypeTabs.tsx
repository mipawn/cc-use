import type { CLIType } from "../api/client";
import ProviderTypeSegmented from "./ProviderTypeSegmented";

interface TypeTabsProps {
  value: "all" | CLIType;
  onChange: (value: "all" | CLIType) => void;
}

export default function TypeTabs({ value, onChange }: TypeTabsProps) {
  return (
    <ProviderTypeSegmented
      value={value}
      onChange={onChange}
      showAll
    />
  );
}
