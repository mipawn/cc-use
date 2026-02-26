import { spawn } from 'child_process'
import type { TerminalStrategy, EnvObject } from './base'
import { escapeEnvValue, sanitizePath } from './escape'

export class CmdStrategy implements TerminalStrategy {
  name = 'Command Prompt'

  async isAvailable(): Promise<boolean> {
    return process.platform === 'win32'
  }

  async launch(path: string, env: EnvObject, cliCommand?: string): Promise<void> {
    const safePath = sanitizePath(path)
    const envSetCommands = Object.entries(env)
      .map(([key, value]) => `set "${key}=${escapeEnvValue(value)}"`)
      .join(' && ')

    // Use pushd to support UNC paths (e.g. \\psf\Home\...)
    let finalCommand = `pushd "${safePath}"`
    if (envSetCommands) {
      finalCommand += ` && ${envSetCommands}`
    }
    if (cliCommand) {
      finalCommand += ` && ${cliCommand}`
    }

    spawn('cmd.exe', ['/k', finalCommand], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  }
}
