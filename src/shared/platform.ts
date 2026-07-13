export const PLATFORM_IDS = ['claude', 'codex', 'opencode'] as const

export type PlatformId = (typeof PLATFORM_IDS)[number]

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
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'OpenCode',
    accent: '#6FA8DC',
    accentDim: '#6FA8DC22',
    accentHover: '#5d94c4'
  }
}

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && PLATFORM_IDS.includes(value as PlatformId)
}
