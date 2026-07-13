import { describe, expect, it } from 'vitest'
import {
  createOpenCodeConfig,
  createSlimConfig,
  OPENCODE_GO_MODELS,
  OPENCODE_ROUTING_PROFILE,
  OPENCODE_SLIM_VERSION
} from '../src/shared/opencode'

describe('Cadence OpenCode configuration', () => {
  it('pins the plugin and isolates OpenCode Go as the provider', () => {
    expect(createOpenCodeConfig()).toMatchObject({
      autoupdate: false,
      default_agent: 'orchestrator',
      enabled_providers: ['opencode-go'],
      plugin: [`oh-my-opencode-slim@${OPENCODE_SLIM_VERSION}`]
    })
  })

  it('uses the approved primary and fallback chain for every role', () => {
    const config = createSlimConfig() as {
      preset: string
      disabled_agents: string[]
      presets: Record<string, Record<string, { model: Array<string | { id: string; variant?: string }> }>>
      agents: Record<string, { model: Array<string | { id: string; variant?: string }> }>
      council: { presets: Record<string, Record<string, { model: string; variant?: string }>> }
    }
    const preset = config.presets[OPENCODE_ROUTING_PROFILE]
    const m = OPENCODE_GO_MODELS

    expect(config.preset).toBe(OPENCODE_ROUTING_PROFILE)
    expect(config.disabled_agents).toEqual([])
    expect(preset.orchestrator.model).toEqual([m.glm52, m.kimi27, m.mimoPro])
    expect(preset.oracle.model).toEqual([{ id: m.qwen37Max, variant: 'max' }, m.glm52, m.mimoPro])
    expect(preset.explorer.model).toEqual([m.deepSeekFlash, m.mimo, m.minimaxM3])
    expect(preset.librarian.model).toEqual([m.deepSeekFlash, m.mimo, m.minimaxM3])
    expect(preset.fixer.model).toEqual([m.deepSeekPro, m.kimi27, m.minimaxM3])
    expect(preset.designer.model).toEqual([m.kimi27, m.minimaxM3, m.qwen37Plus])
    expect(preset.observer.model).toEqual([m.qwen37Plus, m.kimi27, m.minimaxM3])
    expect(config.agents['quick-fixer'].model).toEqual([
      { id: m.deepSeekFlash, variant: 'high' },
      m.mimo,
      m.minimaxM3
    ])
    expect(config.agents['deep-fixer'].model).toEqual([m.kimi27, m.glm52, m.deepSeekPro])
    expect(Object.values(config.council.presets['cadence-critical']).map((entry) => entry.model)).toEqual([
      m.qwen37Max,
      m.glm52,
      m.kimi27,
      m.mimoPro
    ])
  })

  it('keeps background orchestration on while disabling duplicate companion surfaces', () => {
    expect(createSlimConfig()).toMatchObject({
      autoUpdate: false,
      companion: { enabled: false },
      multiplexer: { type: 'none' },
      fallback: { enabled: true, retry_on_empty: true, runtimeOverride: true }
    })
  })
})
