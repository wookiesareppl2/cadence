import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createOpenCodeConfig,
  createOpenCodeRoutingManifest,
  createSlimConfig,
  OPENCODE_GO_MODELS,
  OPENCODE_MEMORY_BANK_WORKFLOW_REVISION,
  OPENCODE_ROUTING_PROFILE,
  OPENCODE_ROUTING_REVISION,
  OPENCODE_SLIM_VERSION
} from '../src/shared/opencode'

describe('Cadence OpenCode configuration', () => {
  it('allows compatible Slim auto-updates while isolating OpenCode Go as the provider', () => {
    expect(createOpenCodeConfig()).toMatchObject({
      autoupdate: false,
      default_agent: 'orchestrator',
      enabled_providers: ['opencode-go'],
      plugin: ['oh-my-opencode-slim']
    })
    expect(createOpenCodeRoutingManifest()).toMatchObject({
      profile: OPENCODE_ROUTING_PROFILE,
      routingRevision: OPENCODE_ROUTING_REVISION,
      memoryBankWorkflowRevision: OPENCODE_MEMORY_BANK_WORKFLOW_REVISION,
      managedSkills: ['start', 'save', 'cadence-merge-review'],
      managedCommands: ['start', 'save'],
      slimVersion: OPENCODE_SLIM_VERSION,
      managedBy: 'Cadence'
    })
  })

  it('bumps the routing revision whenever the routing preset changes', () => {
    // The runtime treats a profile as already configured when the manifest
    // carries this exact revision, so it only rewrites the slim config when the
    // revision differs. A preset change that does not bump the revision is
    // therefore silently NEVER delivered — the app keeps serving the old models
    // while the source says otherwise. This test pins the revision to the
    // preset's shape: change the preset, and it fails until the revision moves.
    const preset = (
      createSlimConfig() as {
        presets: Record<string, Record<string, { model: Array<string | { id: string; variant?: string }> }>>
      }
    ).presets[OPENCODE_ROUTING_PROFILE]
    const shape = JSON.stringify(
      Object.fromEntries(Object.entries(preset).map(([role, cfg]) => [role, cfg.model]))
    )
    const shapeFingerprint = createHash('sha256').update(shape).digest('hex').slice(0, 12)

    // Update BOTH values together, in the same change, or not at all.
    expect({ revision: OPENCODE_ROUTING_REVISION, shapeFingerprint }).toEqual({
      revision: 3,
      shapeFingerprint: '4fb551f42509'
    })
  })

  it('can pin an isolated candidate for transactional major validation', () => {
    expect(createOpenCodeConfig({ slimVersion: '3.0.0', pinSlimPlugin: true })).toMatchObject({
      plugin: ['oh-my-opencode-slim@3.0.0']
    })
    expect(createSlimConfig({ slimVersion: '3.0.0', autoUpdate: false })).toMatchObject({
      $schema: 'https://unpkg.com/oh-my-opencode-slim@3.0.0/oh-my-opencode-slim.schema.json',
      autoUpdate: false
    })
    expect(createOpenCodeRoutingManifest('3.0.0')).toMatchObject({ slimVersion: '3.0.0' })
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
    // The orchestrator runs the managed /start and /save skills, so its
    // instruction-following decides whether the memory-route resolver is
    // invoked at all. glm-5.2 led this list through v0.1.30-v0.1.32 and skipped
    // the resolver in every observed session; the high-judgment model leads now.
    expect(preset.orchestrator.model).toEqual([
      { id: m.qwen37Max, variant: 'max' },
      m.glm52,
      m.kimi27,
      m.mimoPro
    ])
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

  it('keeps background orchestration and compatible updates on while disabling duplicate companion surfaces', () => {
    expect(createSlimConfig()).toMatchObject({
      autoUpdate: true,
      companion: { enabled: false },
      multiplexer: { type: 'none' },
      fallback: { enabled: true, retry_on_empty: true, runtimeOverride: true }
    })
  })

  it('does not alias custom agents with invalid human-readable display names', () => {
    const config = createSlimConfig() as {
      agents: Record<string, { displayName?: string }>
      presets: Record<string, Record<string, { displayName?: string }>>
    }
    const entries = [
      ...Object.values(config.agents),
      ...Object.values(config.presets[OPENCODE_ROUTING_PROFILE])
    ]

    for (const entry of entries) {
      if (entry.displayName === undefined) continue
      expect(entry.displayName).toMatch(/^[a-z][a-z0-9_-]*$/i)
    }
    expect(config.agents['quick-fixer']).not.toHaveProperty('displayName')
    expect(config.agents['deep-fixer']).not.toHaveProperty('displayName')
  })
})
