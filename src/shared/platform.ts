export type PlatformId = 'claude' | 'codex'

export type PlatformConfig = {
  id: PlatformId
  label: string
  shortLabel: string
  accent: string
  accentDim: string
  accentHover: string
}

export const PLATFORM_CONFIG: Record<PlatformId, PlatformConfig> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    accent: '#E07A5F',
    accentDim: '#E07A5F33',
    accentHover: '#c96a50'
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    accent: '#81B29A',
    accentDim: '#81B29A22',
    accentHover: '#6d9e86'
  }
}
