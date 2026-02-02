import type { TerminalStrategy, EnvObject } from './strategies/base'
import { ITerm2Strategy } from './strategies/iterm2'
import { MacTerminalStrategy } from './strategies/macTerminal'
import { WindowsTerminalStrategy } from './strategies/windowsTerminal'
import { CmdStrategy } from './strategies/cmd'
import { getProvider } from '../providerService'
import { getProject, updateProjectLastOpened } from '../projectService'

const strategies: TerminalStrategy[] = [
  new ITerm2Strategy(),
  new MacTerminalStrategy(),
  new WindowsTerminalStrategy(),
  new CmdStrategy(),
]

let selectedStrategy: TerminalStrategy | null = null

export async function getAvailableStrategy(): Promise<TerminalStrategy | null> {
  if (selectedStrategy) return selectedStrategy

  for (const strategy of strategies) {
    if (await strategy.isAvailable()) {
      selectedStrategy = strategy
      return strategy
    }
  }
  return null
}

export async function launchTerminal(projectId: string): Promise<void> {
  const project = await getProject(projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const env = await buildEnvForProject(project.providerId)
  await launchWithEnv(project.path, env)
  await updateProjectLastOpened(projectId)
}

export async function launchTerminalWithPath(
  path: string,
  providerId?: string
): Promise<void> {
  const env = await buildEnvForProject(providerId ?? null)
  await launchWithEnv(path, env)
}

async function launchWithEnv(path: string, env: EnvObject): Promise<void> {
  const strategy = await getAvailableStrategy()
  if (!strategy) {
    throw new Error('No terminal available')
  }

  await strategy.launch(path, env)
}

async function buildEnvForProject(providerId: string | null): Promise<EnvObject> {
  const env: EnvObject = {}

  if (providerId) {
    const provider = await getProvider(providerId)
    if (provider) {
      // Set proxy URL for Claude Code / Codex CLI
      env.ANTHROPIC_BASE_URL = `http://localhost:12345`
      env.OPENAI_BASE_URL = `http://localhost:12345`

      // Store the actual provider info for the proxy to use
      env.CC_USE_PROVIDER_ID = providerId
      env.CC_USE_PROVIDER_BASE_URL = provider.baseUrl
    }
  }

  return env
}
