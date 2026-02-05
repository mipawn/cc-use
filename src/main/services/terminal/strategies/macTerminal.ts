import { exec } from 'child_process'
import { promisify } from 'util'
import type { TerminalStrategy, EnvObject } from './base'

const execAsync = promisify(exec)

export class MacTerminalStrategy implements TerminalStrategy {
  name = 'Terminal'

  async isAvailable(): Promise<boolean> {
    return process.platform === 'darwin'
  }

  async launch(path: string, env: EnvObject, cliCommand?: string): Promise<void> {
    // Escape path for shell
    const escapedPath = path.replace(/'/g, "'\\''")

    // Build inline environment variables (KEY="value" KEY2="value2" command)
    const envInline = Object.entries(env)
      .map(([key, value]) => {
        const escapedValue = value.replace(/"/g, '\\"')
        return `${key}="${escapedValue}"`
      })
      .join(' ')

    // Build the full command: cd to path, then run CLI with inline env vars
    let fullCommand = `cd '${escapedPath}' && clear`
    if (cliCommand) {
      fullCommand += ` && ${envInline} ${cliCommand}`
    }

    // Escape for AppleScript string
    const escapedCommand = fullCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

    const script = `
      tell application "Terminal"
        activate
        do script "${escapedCommand}"
      end tell
    `

    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`)
  }
}
