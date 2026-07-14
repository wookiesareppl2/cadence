import { describe, expect, it } from 'vitest'
import {
  classifyOpenCodeSlimUpdate,
  compareOpenCodeSlimVersions,
  missingCadenceOpenCodeAgents,
  parseOpenCodeSlimVersion
} from '../src/shared/opencode-slim-updates'

describe('OpenCode Slim update policy', () => {
  it('parses stable and prerelease semantic versions', () => {
    expect(parseOpenCodeSlimVersion('v2.3.4')).toEqual({ major: 2, minor: 3, patch: 4 })
    expect(parseOpenCodeSlimVersion('3.0.0-beta.2')).toEqual({ major: 3, minor: 0, patch: 0 })
    expect(parseOpenCodeSlimVersion('latest')).toBeNull()
  })

  it('classifies same-major and major updates separately', () => {
    expect(classifyOpenCodeSlimUpdate('2.1.1', '2.2.0')).toBe('same-major-update')
    expect(classifyOpenCodeSlimUpdate('2.2.0', '3.0.0')).toBe('major-update')
    expect(classifyOpenCodeSlimUpdate('2.2.0', '2.2.0')).toBe('current')
    expect(classifyOpenCodeSlimUpdate('3.0.0', '2.9.0')).toBe('current')
    expect(classifyOpenCodeSlimUpdate(null, '3.0.0')).toBe('invalid')
  })

  it('compares versions numerically rather than lexically', () => {
    expect(compareOpenCodeSlimVersions('2.10.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareOpenCodeSlimVersions('2.0.9', '2.1.0')).toBeLessThan(0)
  })

  it('finds missing agents without confusing partial names', () => {
    const required = ['orchestrator', 'oracle', 'quick-fixer']
    expect(missingCadenceOpenCodeAgents('orchestrator\noracle\nquick-fixer', required)).toEqual([])
    expect(missingCadenceOpenCodeAgents('orchestrator-plus\noracle', required)).toEqual([
      'orchestrator',
      'quick-fixer'
    ])
  })
})
