export function formatOutputSpeed(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) || value <= 0 ? '—' : `${value.toFixed(1)} tok/s`
}

export function formatRequestDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`
}
