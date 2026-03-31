import type { CreateApiKeyInput, CreateProviderInput, ProviderType } from '@shared/types'

interface QuickAddInput {
  providerName: string
  providerBaseUrl: string
  providerIcon: string
  keyAlias?: string
  keyValue: string
  keyType: ProviderType[]
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
    },
    apiKey: {
      alias: data.keyAlias,
      value: data.keyValue,
      types: data.keyType,
    },
  }
}
