import { exec } from 'child_process'
import { promisify } from 'util'
import type { TerminalStrategy, EnvObject } from './base'

const execAsync = promisify(exec)

export class MacTerminalStrategy implements TerminalStrategy {
  name = 'Terminal'

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin'
  }

  async launch(path: string, env: EnvObject): Promise<void> {
    const envExports = Object.entries(env)
      .map(([key, value]) => `export ${key}="${value.replace(/"/g, '\\"')}"`)
      .join('; ')

    const script = `
      tell application "Terminal"
        activate
        do script "cd \\"${path.replace(/"/g, '\\"')}\\"; ${envExports}; clear"
      end tell
    `

    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`)
  }
}
