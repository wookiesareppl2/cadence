import type { PlanUsageRefreshMeta, UsageWindow } from './claude-plan-usage'

export const OPENCODE_PROVIDER_ID = 'opencode-go'
export const OPENCODE_CONFIG_DIR = '$HOME/.config/cadence/opencode'
export const OPENCODE_MINIMUM_VERSION = '1.17.18'
export const OPENCODE_SLIM_VERSION = '2.1.1'
export const OPENCODE_ROUTING_PROFILE = 'cadence-go-capability-v1'

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

export function createOpenCodeConfig(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    default_agent: 'orchestrator',
    enabled_providers: [OPENCODE_PROVIDER_ID],
    plugin: [`oh-my-opencode-slim@${OPENCODE_SLIM_VERSION}`]
  }
}

export function createSlimConfig(): Record<string, unknown> {
  const quickFixer: OpenCodeAgentConfig = {
    displayName: 'Quick Fixer',
    model: [{ id: models.deepSeekFlash, variant: 'high' }, models.mimo, models.minimaxM3],
    prompt:
      'Implement small deterministic changes exactly as requested. Stay within the stated files and contract. Run focused validation. Escalate instead of changing architecture, public APIs, persistence, authentication, concurrency, native boundaries, or security behavior.',
    orchestratorPrompt:
      '@quick-fixer\n- Role: fast implementation for small, deterministic, low-risk changes\n- **Delegate when:** the requirement and solution are already clear, the edit is localized, and no architecture or cross-boundary decision is involved\n- **Do not delegate when:** root cause is uncertain, multiple subsystems are involved, or the task touches IPC, auth, security, persistence, migrations, concurrency, or native modules'
  }

  const deepFixer: OpenCodeAgentConfig = {
    displayName: 'Deep Fixer',
    model: [models.kimi27, models.glm52, models.deepSeekPro],
    prompt:
      'Own complex implementation tasks end to end. Inspect the relevant architecture before editing, preserve established contracts, coordinate file ownership, add risk-proportionate tests, and verify the complete behavior. Prefer root-cause fixes over patches and report unresolved risks precisely.',
    orchestratorPrompt:
      '@deep-fixer\n- Role: autonomous implementation for complex or high-risk engineering work\n- **Delegate when:** work crosses processes or subsystems, the root cause is unclear, or it involves architecture, IPC, authentication, security, persistence, migrations, concurrency, native modules, or broad refactors\n- **Do not delegate when:** the task is read-only analysis or a small deterministic edit'
  }

  const preset: Record<string, OpenCodeAgentConfig> = {
    orchestrator: {
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
    $schema: `https://unpkg.com/oh-my-opencode-slim@${OPENCODE_SLIM_VERSION}/oh-my-opencode-slim.schema.json`,
    preset: OPENCODE_ROUTING_PROFILE,
    setDefaultAgent: true,
    presets: { [OPENCODE_ROUTING_PROFILE]: preset },
    agents: {
      'quick-fixer': quickFixer,
      'deep-fixer': deepFixer
    },
    disabled_agents: [],
    image_routing: 'auto',
    autoUpdate: false,
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

export type OpenCodeActivitySnapshot = {
  sessionId: string
  jobs: OpenCodeAgentActivity[]
  pendingTodos: number
  completedTodos: number
  fetchedAt: string
}
