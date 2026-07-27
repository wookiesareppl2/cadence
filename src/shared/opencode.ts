import type { PlanUsageRefreshMeta, UsageWindow } from './claude-plan-usage'

export const OPENCODE_PROVIDER_ID = 'opencode-go'
export const OPENCODE_CONFIG_DIR = '$HOME/.config/cadence/opencode'
export const OPENCODE_MINIMUM_VERSION = '1.17.18'
export const OPENCODE_SLIM_VERSION = '2.1.1'
export const OPENCODE_ROUTING_PROFILE = 'cadence-go-capability-v1'
// Bump whenever the routing preset changes. The runtime treats a profile as
// already configured when the manifest carries this exact revision, so a preset
// change that does not bump it is silently never delivered.
export const OPENCODE_ROUTING_REVISION = 4
export const OPENCODE_MEMORY_BANK_WORKFLOW_REVISION = 3

type ModelEntry = string | { id: string; variant?: string }

export type OpenCodeAgentConfig = {
  model: ModelEntry[]
  variant?: string
  prompt?: string
  orchestratorPrompt?: string
  displayName?: string
}

const models = {
  glm52: 'opencode-go/glm-5.2',
  kimi27: 'opencode-go/kimi-k2.7-code',
  qwen37Max: 'opencode-go/qwen3.7-max',
  qwen37Plus: 'opencode-go/qwen3.7-plus',
  deepSeekPro: 'opencode-go/deepseek-v4-pro',
  deepSeekFlash: 'opencode-go/deepseek-v4-flash',
  mimo: 'opencode-go/mimo-v2.5',
  mimoPro: 'opencode-go/mimo-v2.5-pro',
  minimaxM3: 'opencode-go/minimax-m3'
} as const

export const OPENCODE_GO_MODELS = Object.freeze({ ...models })

export type ManagedOpenCodeConfigOptions = {
  slimVersion?: string
  pinSlimPlugin?: boolean
  autoUpdate?: boolean
}

export function createOpenCodeConfig({
  slimVersion = OPENCODE_SLIM_VERSION,
  pinSlimPlugin = false
}: ManagedOpenCodeConfigOptions = {}): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    default_agent: 'orchestrator',
    enabled_providers: [OPENCODE_PROVIDER_ID],
    plugin: [pinSlimPlugin ? `oh-my-opencode-slim@${slimVersion}` : 'oh-my-opencode-slim']
  }
}

export function createOpenCodeRoutingManifest(slimVersion = OPENCODE_SLIM_VERSION): Record<string, unknown> {
  return {
    profile: OPENCODE_ROUTING_PROFILE,
    routingRevision: OPENCODE_ROUTING_REVISION,
    memoryBankWorkflowRevision: OPENCODE_MEMORY_BANK_WORKFLOW_REVISION,
    managedSkills: ['start', 'save', 'cadence-merge-review'],
    managedCommands: ['start', 'save'],
    openCodeMinimumVersion: OPENCODE_MINIMUM_VERSION,
    slimVersion,
    managedBy: 'Cadence'
  }
}

export function createSlimConfig({
  slimVersion = OPENCODE_SLIM_VERSION,
  autoUpdate = true
}: ManagedOpenCodeConfigOptions = {}): Record<string, unknown> {
  const quickFixer: OpenCodeAgentConfig = {
    model: [{ id: models.deepSeekFlash, variant: 'high' }, models.mimo, models.minimaxM3],
    prompt:
      'Implement small deterministic changes exactly as requested. Stay within the stated files and contract. Run focused validation. Escalate instead of changing architecture, public APIs, persistence, authentication, concurrency, native boundaries, or security behavior.',
    orchestratorPrompt:
      '@quick-fixer\n- Role: fast implementation for small, deterministic, low-risk changes\n- **Delegate when:** the requirement and solution are already clear, the edit is localized, and no architecture or cross-boundary decision is involved\n- **Do not delegate when:** root cause is uncertain, multiple subsystems are involved, or the task touches IPC, auth, security, persistence, migrations, concurrency, or native modules'
  }

  const deepFixer: OpenCodeAgentConfig = {
    model: [models.kimi27, models.glm52, models.deepSeekPro],
    prompt:
      'Own complex implementation tasks end to end. Inspect the relevant architecture before editing, preserve established contracts, coordinate file ownership, add risk-proportionate tests, and verify the complete behavior. Prefer root-cause fixes over patches and report unresolved risks precisely.',
    orchestratorPrompt:
      '@deep-fixer\n- Role: autonomous implementation for complex or high-risk engineering work\n- **Delegate when:** work crosses processes or subsystems, the root cause is unclear, or it involves architecture, IPC, authentication, security, persistence, migrations, concurrency, native modules, or broad refactors\n- **Do not delegate when:** the task is read-only analysis or a small deterministic edit'
  }

  const preset: Record<string, OpenCodeAgentConfig> = {
    orchestrator: {
      // Restored to glm-5.2 after the resolver-skip investigation closed.
      //
      // v0.1.33 promoted qwen3.7-max here on the theory that the orchestrator
      // was too weak to follow the skill's mandatory first tool call. It was
      // not: OpenCode had never served Cadence's managed skill at all. Stale
      // pre-vault skills in ~/.agents/skills and ~/.claude/skills shadowed the
      // managed profile, and every model was faithfully following those
      // instead. Removing them fixed /start and /save on this same list's
      // original leader, so the heavier model bought nothing and cost plan
      // budget on every session.
      model: [models.glm52, models.kimi27, models.mimoPro]
    },
    oracle: {
      model: [{ id: models.qwen37Max, variant: 'max' }, models.glm52, models.mimoPro]
    },
    explorer: {
      model: [models.deepSeekFlash, models.mimo, models.minimaxM3]
    },
    librarian: {
      model: [models.deepSeekFlash, models.mimo, models.minimaxM3]
    },
    designer: {
      model: [models.kimi27, models.minimaxM3, models.qwen37Plus]
    },
    fixer: {
      model: [models.deepSeekPro, models.kimi27, models.minimaxM3]
    },
    observer: {
      model: [models.qwen37Plus, models.kimi27, models.minimaxM3]
    },
    council: {
      model: [{ id: models.qwen37Max, variant: 'max' }, models.glm52, models.kimi27, models.mimoPro]
    },
    'quick-fixer': quickFixer,
    'deep-fixer': deepFixer
  }

  return {
    $schema: `https://unpkg.com/oh-my-opencode-slim@${slimVersion}/oh-my-opencode-slim.schema.json`,
    preset: OPENCODE_ROUTING_PROFILE,
    setDefaultAgent: true,
    presets: { [OPENCODE_ROUTING_PROFILE]: preset },
    agents: {
      'quick-fixer': quickFixer,
      'deep-fixer': deepFixer
    },
    disabled_agents: [],
    image_routing: 'auto',
    autoUpdate,
    compactSidebar: true,
    multiplexer: { type: 'none' },
    companion: { enabled: false },
    fallback: {
      enabled: true,
      timeoutMs: 30000,
      retryDelayMs: 750,
      retry_on_empty: true,
      maxRetries: 3,
      runtimeOverride: true
    },
    backgroundJobs: {
      maxSessionsPerAgent: 3,
      readContextMinLines: 10,
      readContextMaxFiles: 12
    },
    council: {
      default_preset: 'cadence-critical',
      timeout: 240000,
      councillor_execution_mode: 'parallel',
      councillor_retries: 2,
      presets: {
        'cadence-critical': {
          strategic: { model: models.qwen37Max, variant: 'max' },
          systems: { model: models.glm52 },
          implementation: { model: models.kimi27 },
          skeptic: { model: models.mimoPro }
        }
      }
    },
    interview: {
      maxQuestions: 3,
      autoOpenBrowser: false,
      dashboard: false,
      port: 0
    }
  }
}

export type OpenCodePlanUsage = {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  monthly: UsageWindow | null
  fiveHourCost: number
  sevenDayCost: number
  monthlyCost: number
  source: 'local-sessions'
  isEstimate: true
  fetchedAt: string
  refresh?: PlanUsageRefreshMeta
}

export type OpenCodeAgentActivity = {
  sessionId: string
  parentSessionId: string | null
  title: string
  agent: string | null
  model: string | null
  status: 'idle' | 'busy' | 'retry' | 'unknown'
  updatedAt: string
  cost: number
}

export type OpenCodeAgentPaneLayout = 'tiled' | 'rows' | 'columns'

// OpenCode session ids look like `ses_06cf94579ffetKvMLAgwXbVwZq`. The server
// validates that prefix itself and answers anything else with a 500
// (`Expected a string starting with "ses"`). Cadence identifies Claude and Codex
// sessions by UUID instead, so an id belonging to another platform must never
// reach an OpenCode call — a selection that carries across platforms otherwise
// turns every poll into a server error.
export function isOpenCodeSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('ses')
}

function terminalIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-48) || 'session'
}

export function openCodeAgentTerminalId(parentSessionId: string, childSessionId: string): string {
  return `opencode-agent-${terminalIdPart(parentSessionId)}-${terminalIdPart(childSessionId)}`
}

export function openCodeAgentAttachCommand(sessionId: string): string {
  const quoted = `'${sessionId.replace(/'/g, `'"'"'`)}'`
  return `opencode --session ${quoted}`
}

export type OpenCodeActivitySnapshot = {
  sessionId: string
  jobs: OpenCodeAgentActivity[]
  pendingTodos: number
  completedTodos: number
  fetchedAt: string
}

export const OPENCODE_COMPANION_STATE_CHANNEL = 'opencode:companion-state'
export const OPENCODE_COMPANION_FOCUS_CHANNEL = 'opencode:companion-focus'

export type OpenCodeCompanionTarget = {
  sessionId: string | null
  projectId: string | null
  projectName: string | null
}

export type OpenCodeCompanionState = {
  enabled: boolean
  target: OpenCodeCompanionTarget
}

export type OpenCodeCompanionBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type OpenCodeCompanionPreferences = OpenCodeCompanionState & {
  bounds: OpenCodeCompanionBounds | null
}

export const DEFAULT_OPENCODE_COMPANION_PREFERENCES: OpenCodeCompanionPreferences = {
  enabled: false,
  target: {
    sessionId: null,
    projectId: null,
    projectName: null
  },
  bounds: null
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

export function parseOpenCodeCompanionPreferences(value: unknown): OpenCodeCompanionPreferences {
  if (typeof value !== 'object' || value === null) return DEFAULT_OPENCODE_COMPANION_PREFERENCES
  const source = value as Partial<OpenCodeCompanionPreferences>
  const targetSource =
    typeof source.target === 'object' && source.target !== null
      ? (source.target as Partial<OpenCodeCompanionTarget>)
      : {}
  const boundsSource =
    typeof source.bounds === 'object' && source.bounds !== null
      ? (source.bounds as Partial<OpenCodeCompanionBounds>)
      : null
  const x = finiteNumber(boundsSource?.x)
  const y = finiteNumber(boundsSource?.y)
  const width = finiteNumber(boundsSource?.width)
  const height = finiteNumber(boundsSource?.height)

  return {
    enabled: source.enabled === true,
    target: {
      sessionId: nullableText(targetSource.sessionId),
      projectId: nullableText(targetSource.projectId),
      projectName: nullableText(targetSource.projectName)
    },
    bounds:
      x !== null && y !== null && width !== null && height !== null
        ? {
            x,
            y,
            width: Math.min(640, Math.max(300, width)),
            height: Math.min(720, Math.max(180, height))
          }
        : null
  }
}
