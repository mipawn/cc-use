/** Static, editable suggestions. Sources and version snapshots: docs/v3.10.2/cli-fingerprint.md. */
export const USER_AGENT_PRESETS = [
  { name: 'Claude Code', value: 'claude-cli/2.1.161 (external, cli)' },
  { name: 'Codex App', value: 'Codex Desktop/26.924.22138 (Mac OS; arm64)' },
  { name: 'Grok', value: 'grok-shell/1.0.34 (macos; aarch64)' },
] as const

export function userAgentOptions(saved: string[], labels: { builtin: string; saved: string }) {
  return [
    {
      label: labels.builtin,
      options: USER_AGENT_PRESETS.map(({ name, value }) => ({
        value,
        label: `${name} — ${value}`,
      })),
    },
    {
      label: labels.saved,
      options: [...new Set(saved)]
        .filter((value) => !USER_AGENT_PRESETS.some((preset) => preset.value === value))
        .map((value) => ({ value, label: value })),
    },
  ].filter((group) => group.options.length > 0)
}
