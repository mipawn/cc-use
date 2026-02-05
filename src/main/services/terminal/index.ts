import type { TerminalStrategy, EnvObject } from './strategies/base'
import { ITerm2Strategy } from './strategies/iterm2'
import { MacTerminalStrategy } from './strategies/macTerminal'
import { WindowsTerminalStrategy } from './strategies/windowsTerminal'
import { CmdStrategy } from './strategies/cmd'
import { getProvider } from '../providerService'
import { getApiKey } from '../apiKeyService'
import { getProject, updateProjectLastOpened } from '../projectService'
import { getGlobalSettings } from '../settingsService'
import { createUsageLog } from '../usageLogService'
import { createSession } from '../proxy/sessionManager'
import type { ProviderType, TerminalType } from '@shared/types'

// All available strategies
const allStrategies: Record<string, TerminalStrategy> = {
  iterm2: new ITerm2Strategy(),
  terminal: new MacTerminalStrategy(),
  wt: new WindowsTerminalStrategy(),
  cmd: new CmdStrategy(),
}

// Get strategy by terminal type
async function getStrategyByType(terminalType: TerminalType): Promise<TerminalStrategy | null> {
  const strategy = allStrategies[terminalType]
  if (strategy && await strategy.isAvailable()) {
    return strategy
  }
  return null
}

// Get first available strategy (fallback)
async function getFirstAvailableStrategy(): Promise<TerminalStrategy | null> {
  for (const strategy of Object.values(allStrategies)) {
    if (await strategy.isAvailable()) {
      return strategy
    }
  }
  return null
}

// Get strategy based on settings or fallback
export async function getAvailableStrategy(): Promise<TerminalStrategy | null> {
  const settings = await getGlobalSettings()
  const preferredType = settings.defaultTerminalType

  // Try preferred terminal first
  const preferredStrategy = await getStrategyByType(preferredType)
  if (preferredStrategy) {
    return preferredStrategy
  }

  // Fallback to first available
  return getFirstAvailableStrategy()
}

export async function launchTerminal(
  projectId: string,
  options?: { providerId?: string; apiKeyId?: string }
): Promise<void> {
  const project = await getProject(projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  // Use override providerId if provided, otherwise use project's bound provider
  const providerId = options?.providerId || project.providerId
  const apiKeyId = options?.apiKeyId || project.apiKeyId
  const cliType = project.cliType || 'claude'

  const env = await buildEnvForProject(providerId ?? null, apiKeyId ?? null, cliType)
  await launchWithEnv(project.path, env, cliType)
  await updateProjectLastOpened(projectId)

  // Record usage log for statistics
  if (providerId && apiKeyId) {
    try {
      await createUsageLog(projectId, providerId, apiKeyId, cliType)
    } catch (error) {
      console.error('Failed to record usage log:', error)
      // Don't throw - usage logging should not block terminal launch
    }
  }
}

export async function launchTerminalWithPath(
  path: string,
  providerId?: string,
  cliType: ProviderType = 'claude'
): Promise<void> {
  const env = await buildEnvForProject(providerId ?? null, null, cliType)
  await launchWithEnv(path, env, cliType)
}

async function launchWithEnv(path: string, env: EnvObject, cliType: ProviderType): Promise<void> {
  const strategy = await getAvailableStrategy()
  if (!strategy) {
    throw new Error('No terminal available')
  }

  // Add the CLI command to run
  const cliCommand = cliType === 'codex' ? 'codex' : 'claude'

  await strategy.launch(path, env, cliCommand)
}

async function buildEnvForProject(
  providerId: string | null,
  apiKeyId: string | null,
  cliType: ProviderType
): Promise<EnvObject> {
  const settings = await getGlobalSettings()
  const env: EnvObject = {}
  const proxyPort = settings.proxyPort || 12345

  if (providerId && apiKeyId) {
    const provider = await getProvider(providerId)
    const apiKey = await getApiKey(apiKeyId)

    if (provider && apiKey) {
      // Create a session for this launch
      const session = createSession(providerId, apiKeyId)

      // Use the session token as the API key - proxy will resolve it
      if (cliType === 'codex') {
        env.OPENAI_BASE_URL = `http://localhost:${proxyPort}`
        env.OPENAI_API_KEY = session.sessionToken
      } else {
        env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`
        env.ANTHROPIC_API_KEY = session.sessionToken
      }
    }
  } else if (providerId) {
    // Fallback: only provider, no specific key - this won't work well
    const provider = await getProvider(providerId)
    if (provider) {
      if (cliType === 'codex') {
        env.OPENAI_BASE_URL = `http://localhost:${proxyPort}`
      } else {
        env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}`
      }
    }
  }

  return env
}
