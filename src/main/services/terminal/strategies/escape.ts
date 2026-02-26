// Escape special characters in environment variable values for cmd.exe
// When used inside `set "KEY=VALUE"`, only `"` needs escaping
export function escapeEnvValue(value: string): string {
  return value.replace(/"/g, '""')
}

// Sanitize file path for use in cmd.exe commands
// Remove any embedded double quotes that could break out of the quoted string
export function sanitizePath(p: string): string {
  return p.replace(/"/g, '')
}
