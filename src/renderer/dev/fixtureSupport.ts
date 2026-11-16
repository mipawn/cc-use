export const scenarios = [
  'default',
  'empty',
  'error',
  'partial',
  'stale',
  'routeOnly',
  'configChanged',
  'failed',
  'official',
  'notFound',
  'unknown',
  'quotaError',
  'consoleError',
  'consoleEmpty',
] as const
export type FixtureScenario = (typeof scenarios)[number]

export function parseScenario(search: string): FixtureScenario {
  const value = new URLSearchParams(search).get('scenario') ?? 'default'
  if (!(scenarios as readonly string[]).includes(value)) {
    throw new Error(`[fixture] Unknown scenario: ${value}`)
  }
  return value as FixtureScenario
}

export interface FixtureDiagnostics {
  violations: string[]
  calls: string[]
  reject: (reason: string) => never
}

export function createDiagnostics(onViolation?: (message: string) => void): FixtureDiagnostics {
  const violations: string[] = []
  return {
    violations,
    calls: [],
    reject(reason) {
      const message = `[fixture isolation] ${reason}`
      violations.push(message)
      onViolation?.(message)
      throw new Error(message)
    },
  }
}

/** Namespace-only proxy: returned DTOs stay normal data, never magic empty values. */
export function strictNamespace<T extends object>(
  value: T,
  path: string,
  diagnostics: FixtureDiagnostics,
): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === 'symbol') return Reflect.get(target, key, receiver)
      if (!Object.hasOwn(target, key))
        return diagnostics.reject(`Unimplemented API: ${path}.${key}`)
      return Reflect.get(target, key, receiver)
    },
  })
}

export const clone = <T>(value: T): T => structuredClone(value)
export const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export const utcTimestamp = (date: Date): string =>
  date.toISOString().slice(0, 19).replace('T', ' ')
