import { CLI_TYPES, CLIType } from "../config/types";

const RESET = "\x1b[0m";

/**
 * 获取 CLI 类型的终端 emoji icon
 */
export function getTerminalIcon(type: CLIType): string {
  return CLI_TYPES[type]?.icon.terminal || "⚪";
}

/**
 * 获取带颜色的 CLI 类型名称（用于终端显示）
 */
export function getColoredTypeName(type: CLIType): string {
  const config = CLI_TYPES[type];
  if (!config) return type;
  return `${config.icon.color}${config.displayName}${RESET}`;
}

/**
 * 获取带 icon 和颜色的 CLI 类型标签
 */
export function getTypeLabel(type: CLIType): string {
  const icon = getTerminalIcon(type);
  const coloredName = getColoredTypeName(type);
  return `${icon} ${coloredName}`;
}

/**
 * 获取简短的类型标签（用于列表显示）
 */
export function getShortTypeLabel(type: CLIType): string {
  const icon = getTerminalIcon(type);
  return `${icon} ${type}`;
}

/**
 * 格式化 profile 名称（带类型 icon）
 */
export function formatProfileName(name: string, type: CLIType): string {
  const icon = getTerminalIcon(type);
  return `${icon} ${name}`;
}

/**
 * 获取所有可用的 CLI 类型
 */
export function getAvailableCLITypes(): CLIType[] {
  return Object.keys(CLI_TYPES) as CLIType[];
}
