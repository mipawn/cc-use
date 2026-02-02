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

  async launch(path: string, env: EnvObject): Promise<void> {
    const envSetCommands = Object.entries(env)
      .map(([key, value]) => `set ${key}=${value}`)
      .join(' && ')

    const command = `wt.exe -w 0 new-tab -d "${path}" cmd /k "${envSetCommands}"`
    await execAsync(command)
  }
}
