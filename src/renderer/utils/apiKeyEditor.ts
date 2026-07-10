import type { ClientKind, CreateApiKeyInput, UpdateApiKeyInput } from '@shared/types'

export type ApiKeyEditorInput = Omit<CreateApiKeyInput, 'types'> & {
  id?: string
  types: ClientKind[]
}

export function toCreateApiKeyInput(input: ApiKeyEditorInput): CreateApiKeyInput {
  const { id, ...createInput } = input
  void id
  return createInput
}

export function toUpdateApiKeyInput(input: ApiKeyEditorInput): UpdateApiKeyInput {
  if (!input.id) {
    throw new Error('API key id is required when updating')
  }

  const { id, providerId, ...updateInput } = input
  void providerId
  return { id, ...updateInput }
}
