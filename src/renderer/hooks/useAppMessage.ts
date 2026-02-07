import { App } from 'antd'
import type { MessageInstance } from 'antd/es/message/interface'

// Global message reference, initialized by AppMessageProvider
let globalMessage: MessageInstance | null = null

export function setGlobalMessage(msg: MessageInstance) {
  globalMessage = msg
}

export function getGlobalMessage(): MessageInstance {
  if (!globalMessage) {
    throw new Error('Message not initialized. Ensure App component wraps your application.')
  }
  return globalMessage
}

/**
 * Hook to get antd message instance from App context.
 * Use this instead of importing `message` from 'antd' directly.
 */
export function useAppMessage() {
  const { message } = App.useApp()
  return message
}
