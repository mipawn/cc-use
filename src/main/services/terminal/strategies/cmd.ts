import { spawn } from 'child_process'
import type { TerminalStrategy, EnvObject } from './base'

export class CmdStrategy implements TerminalStrategy {
  name = 'Command Prompt'

  async isAvailable(): Promise<boolean> {
    return process.platform === 'win32'
  }

  async launch(path: string, env: EnvObject): Promise<void> {
    const envSetCommands = Object.entries(env)
      .map(([key, value]) => `set ${key}=${value}`)
      .join(' && ')

    spawn('cmd.exe', ['/k', `cd /d "${path}" && ${envSetCommands}`], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    }).unref()
  }
}
