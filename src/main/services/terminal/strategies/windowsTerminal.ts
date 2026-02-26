import { spawn } from 'child_process'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { TerminalStrategy, EnvObject } from './base'
import { escapeEnvValue, sanitizePath } from './escape'

const execAsync = promisify(exec)

export class WindowsTerminalStrategy implements TerminalStrategy {
  name = 'Windows Terminal'

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      await execAsync('where wt.exe')
      return true
    } catch {
      return false
    }
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

    // Use spawn with args array to avoid nested quoting issues with wt.exe
    const child = spawn('wt.exe', ['-w', '0', 'new-tab', 'cmd', '/k', finalCommand], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }
}
