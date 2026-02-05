export interface EnvObject {
  [key: string]: string
}

export interface TerminalStrategy {
  name: string
  isAvailable(): Promise<boolean>
  launch(path: string, env: EnvObject, cliCommand?: string): Promise<void>
}
