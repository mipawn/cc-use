// CLI 类型定义
export type CLIType = 'claude' | 'codex';

export interface CLITypeConfig {
  type: CLIType;
  command: string;           // 执行的命令
  displayName: string;
  icon: {
    terminal: string;        // 终端 emoji
    color: string;           // ANSI 颜色
  };
}

export const CLI_TYPES: Record<CLIType, CLITypeConfig> = {
  claude: {
    type: 'claude',
    command: 'claude',
    displayName: 'Claude Code',
    icon: { terminal: '🟠', color: '\x1b[38;2;217;119;87m' },
  },
  codex: {
    type: 'codex',
    command: 'codex',
    displayName: 'Codex CLI',
    icon: { terminal: '🟢', color: '\x1b[38;2;16;163;127m' },
  },
};

// 用量查询配置
export interface UsageConfig {
  enabled: boolean;
  templateType: 'newapi' | 'custom';

  // NewAPI 模板参数
  baseUrl?: string;
  accessToken?: string;
  userId?: string;

  // 自定义模板 - 存储完整的脚本代码
  customScript?: string;
}

// 用量数据（运行时，不持久化）
export interface UsageData {
  planName?: string;
  total?: number;
  used?: number;
  remaining?: number;
  todayUsed?: number;
  requestCount?: number;
  unit?: string;
  lastUpdated?: string;
  error?: string;
}

// Provider
export interface Provider {
  id: string;                    // 唯一标识
  name: string;                  // 显示名称
  type: CLIType;                 // CLI 类型
  description?: string;          // 备注
  websiteUrl?: string;           // 官网链接
  env: Record<string, string>;   // 环境变量
  order: number;                 // 排序顺序

  // 用量查询配置
  usageConfig?: UsageConfig;

  createdAt?: string;
  updatedAt?: string;
}

// Common
export interface Common {
  _global?: Record<string, string>;  // 所有类型共享
  claude?: Record<string, string>;
  codex?: Record<string, string>;
}

// Config v3 结构
export interface Config {
  version: string;               // "3"
  common: Common;                // 通用配置
  providers: Provider[];         // 供应商列表
}

export const DEFAULT_CONFIG: Config = {
  version: "3",
  common: {},
  providers: [],
};

// 生成唯一 ID
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
