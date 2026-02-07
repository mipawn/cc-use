/**
 * Usage Parser Service
 * Parses token usage from API responses (Claude and OpenAI formats)
 */

// Token usage from API response
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

// Claude API response usage format
interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// OpenAI API response usage format
interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

// Generic API response with usage
interface ApiResponse {
  usage?: ClaudeUsage | OpenAIUsage
  model?: string
}

/**
 * Parse token usage from API response
 * Supports both Claude and OpenAI response formats
 */
export function parseUsageFromResponse(response: unknown): TokenUsage | null {
  if (!response || typeof response !== 'object') {
    return null
  }

  const resp = response as ApiResponse

  if (!resp.usage) {
    return null
  }

  const usage = resp.usage

  // Try Claude format first
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    const claudeUsage = usage as ClaudeUsage
    return {
      inputTokens: claudeUsage.input_tokens || 0,
      outputTokens: claudeUsage.output_tokens || 0,
      cacheReadTokens: claudeUsage.cache_read_input_tokens || 0,
      cacheCreationTokens: claudeUsage.cache_creation_input_tokens || 0,
    }
  }

  // Try OpenAI format
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    const openaiUsage = usage as OpenAIUsage
    return {
      inputTokens: openaiUsage.prompt_tokens || 0,
      outputTokens: openaiUsage.completion_tokens || 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
  }

  return null
}

/**
 * Parse model name from API response
 */
export function parseModelFromResponse(response: unknown): string | null {
  if (!response || typeof response !== 'object') {
    return null
  }

  const resp = response as ApiResponse
  return resp.model || null
}

/**
 * Parse usage from streaming response
 * For streaming, usage is typically in the last chunk with type 'message_delta' or 'message_stop'
 */
export function parseUsageFromStreamChunk(chunk: string): TokenUsage | null {
  try {
    // Handle SSE format: "data: {...}"
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '))

    for (const line of lines) {
      const jsonStr = line.slice(6) // Remove "data: " prefix

      if (jsonStr === '[DONE]') {
        continue
      }

      try {
        const data = JSON.parse(jsonStr)

        // Claude streaming format - look for message_delta with usage
        if (data.type === 'message_delta' && data.usage) {
          return {
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheReadTokens: data.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: data.usage.cache_creation_input_tokens || 0,
          }
        }

        // Claude streaming - message_start contains input token count
        if (data.type === 'message_start' && data.message?.usage) {
          return {
            inputTokens: data.message.usage.input_tokens || 0,
            outputTokens: 0,
            cacheReadTokens: data.message.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: data.message.usage.cache_creation_input_tokens || 0,
          }
        }

        // OpenAI streaming format - usage in final chunk
        if (data.usage) {
          return parseUsageFromResponse(data)
        }
      } catch {
        // Skip invalid JSON lines
        continue
      }
    }
  } catch {
    // Ignore parsing errors
  }

  return null
}

/**
 * Accumulate usage from multiple stream chunks
 * Claude sends input tokens in message_start and output tokens in message_delta
 */
export class StreamUsageAccumulator {
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private cacheCreationTokens = 0
  private model: string | null = null

  processChunk(chunk: string): void {
    try {
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '))

      for (const line of lines) {
        const jsonStr = line.slice(6)

        if (jsonStr === '[DONE]') {
          continue
        }

        try {
          const data = JSON.parse(jsonStr)

          // Extract model from message_start
          if (data.type === 'message_start' && data.message?.model) {
            this.model = data.message.model
          }

          // Claude message_start - input tokens
          if (data.type === 'message_start' && data.message?.usage) {
            this.inputTokens = data.message.usage.input_tokens || 0
            this.cacheReadTokens = data.message.usage.cache_read_input_tokens || 0
            this.cacheCreationTokens = data.message.usage.cache_creation_input_tokens || 0
          }

          // Claude message_delta - output tokens
          if (data.type === 'message_delta' && data.usage) {
            this.outputTokens = data.usage.output_tokens || 0
          }

          // OpenAI format - full usage in final chunk
          if (data.usage && ('prompt_tokens' in data.usage || 'completion_tokens' in data.usage)) {
            this.inputTokens = data.usage.prompt_tokens || 0
            this.outputTokens = data.usage.completion_tokens || 0
          }

          // Extract model from OpenAI response
          if (data.model && !this.model) {
            this.model = data.model
          }
        } catch {
          continue
        }
      }
    } catch {
      // Ignore errors
    }
  }

  getUsage(): TokenUsage | null {
    if (this.inputTokens === 0 && this.outputTokens === 0) {
      return null
    }

    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
    }
  }

  getModel(): string | null {
    return this.model
  }

  reset(): void {
    this.inputTokens = 0
    this.outputTokens = 0
    this.cacheReadTokens = 0
    this.cacheCreationTokens = 0
    this.model = null
  }
}
