import { exec } from 'child_process'
import { promisify } from 'util'
import type { TerminalStrategy, EnvObject } from './base'

const execAsync = promisify(exec)

export class ITerm2Strategy implements TerminalStrategy {
  name = 'iTerm2'

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('osascript -e \'tell application "System Events" to (name of processes) contains "iTerm2"\'')
      // Check if iTerm2 is installed
      const { stdout } = await execAsync('mdfind "kMDItemCFBundleIdentifier == com.googlecode.iterm2"')
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }

  async launch(path: string, env: EnvObject): Promise<void> {
    const envExports = Object.entries(env)
      .map(([key, value]) => `export ${key}="${value.replace(/"/g, '\\"')}"`)
      .join('; ')

    const script = `
      tell application "iTerm2"
        activate
        tell current window
          create tab with default profile
          tell current session
            write text "cd \\"${path.replace(/"/g, '\\"')}\\""
            write text "${envExports}"
            write text "clear"
          end tell
        end tell
      end tell
    `

    await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`)
  }
}
