import type { CreateApiKeyInput, CreateProviderInput } from '@shared/types'

interface QuickAddInput {
  providerName: string
  providerBaseUrl: string
  providerIcon: string
  keyAlias?: string
  keyValue: string
  keyType: string[] // v3.2.0: 改为 string[] 以支持 ClientKind
  // v3.2.0: 格式转换
  apiFormat?: string
  transformEnabled?: boolean
}

export function buildQuickAddPayload(data: QuickAddInput): {
  provider: CreateProviderInput
  apiKey: Omit<CreateApiKeyInput, 'providerId'>
} {
  const primaryType = data.keyType[0] ?? 'claude'

  return {
    provider: {
      name: data.providerName,
      baseUrl: data.providerBaseUrl,
      icon: data.providerIcon,
      type: primaryType,
      // v3.2.0: 格式转换
      apiFormat: data.apiFormat || 'auto',
      transformEnabled: data.transformEnabled ?? false,
    },
    apiKey: {
      alias: data.keyAlias,
      value: data.keyValue,
      types: data.keyType,
    },
  }
}
