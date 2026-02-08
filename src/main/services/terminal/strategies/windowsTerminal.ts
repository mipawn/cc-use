import { exec } from 'child_process'
import { promisify } from 'util'
import type { TerminalStrategy, EnvObject } from './base'

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
    const envSetCommands = Object.entries(env)
      .map(([key, value]) => `set ${key}=${value}`)
      .join(' && ')

    // Use pushd instead of -d flag to support UNC paths (e.g. \\psf\Home\...)
    // pushd automatically maps UNC paths to a temporary drive letter
    let finalCommand = `pushd "${path}" && ${envSetCommands}`
    if (cliCommand) {
      finalCommand += ` && ${cliCommand}`
    }

    const command = `wt.exe -w 0 new-tab cmd /k "${finalCommand}"`
    await execAsync(command)
  }
}
