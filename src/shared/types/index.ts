// Provider types
export type ProviderType = 'claude' | 'codex'
export type PresetIcon = 'claude' | 'codex' | 'zhipu' | 'minimax' | 'xiaomi' | 'deepseek' | 'custom'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  type: ProviderType
  website: string | null
  remark: string | null
  token: string | null
  icon: string | null
  walletBalanceType: 'none' | 'newapi' | 'custom'
  walletBalanceUrl: string | null
  walletBalancePath: string | null
  walletBalanceHeaders: string | null
  cachedWalletBalance: number | null
  lastBalanceCheckedAt: string | null
  isActive: boolean
}

export interface CreateProviderInput {
  name: string
  baseUrl: string
  type?: ProviderType
  website?: string
  remark?: string
  token?: string
  icon?: string
  walletBalanceType?: 'none' | 'newapi' | 'custom'
  walletBalanceUrl?: string
  walletBalancePath?: string
  walletBalanceHeaders?: string
}

export interface UpdateProviderInput extends Partial<CreateProviderInput> {
  id: string
  isActive?: boolean
}

// API Key types
export interface ApiKey {
  id: string
  providerId: string
  alias: string | null
  value: string
  priority: number
  isExhausted: boolean
}

export interface CreateApiKeyInput {
  providerId: string
  alias?: string
  value: string
  priority?: number
}

export interface UpdateApiKeyInput {
  id: string
  alias?: string
  value?: string
  priority?: number
  isExhausted?: boolean
}

// Project types
export interface Project {
  id: string
  name: string
  path: string
  providerId: string | null
  lastOpenedAt: string | null
}

export interface CreateProjectInput {
  name: string
  path: string
  providerId?: string
}

export interface UpdateProjectInput {
  id: string
  name?: string
  providerId?: string
}

// Proxy types
export interface ProxyStatus {
  isRunning: boolean
  port: number
  requestCount: number
  lastError: string | null
}

// Global settings types
export interface GlobalSettings {
  defaultProviderType: ProviderType
  proxyPort: number
  autoStartProxy: boolean
}
