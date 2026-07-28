import { describe, expect, it } from 'vitest'
import {
  MANAGED_OPENCODE_SKILL_NAMES,
  MANAGED_OPENCODE_WORKFLOW_FILES
} from '../src/main/opencode/opencode-memory-bank-workflow'

// OpenCode resolves skills from `~/.agents/skills/` and `~/.claude/skills/` before
// Cadence's managed profile, so a leftover skill of the same name silently replaces
// Cadence's own. That cost five release cycles (TS-114/PIN-125) because the managed
// file was verified correct on disk every time and nothing checked what actually ran.
// The detection list is derived from the shipped files so a newly managed skill is
// covered the day it is added rather than whenever someone remembers to update a list.

describe('managed OpenCode skill names', () => {
  it('covers every skill Cadence actually ships', () => {
    const shipped = [
      ...new Set(
        MANAGED_OPENCODE_WORKFLOW_FILES.map((file) => file.relativePath.split(/[\\/]/))
          .filter((segments) => segments[0] === 'skills' && segments.length > 2)
          .map((segments) => segments[1])
      )
    ]
    expect([...MANAGED_OPENCODE_SKILL_NAMES].sort()).toEqual(shipped.sort())
  })

  it('includes the two skills that were actually shadowed', () => {
    expect(MANAGED_OPENCODE_SKILL_NAMES).toContain('start')
    expect(MANAGED_OPENCODE_SKILL_NAMES).toContain('save')
  })

  it('lists no duplicates and no path separators', () => {
    expect(new Set(MANAGED_OPENCODE_SKILL_NAMES).size).toBe(MANAGED_OPENCODE_SKILL_NAMES.length)
    for (const name of MANAGED_OPENCODE_SKILL_NAMES) {
      expect(name).not.toMatch(/[\\/]/)
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it('never treats a non-skill managed file as a skill', () => {
    // scripts/ and commands/ ship alongside the skills and must not be probed for.
    expect(MANAGED_OPENCODE_SKILL_NAMES).not.toContain('scripts')
    expect(MANAGED_OPENCODE_SKILL_NAMES).not.toContain('commands')
    expect(MANAGED_OPENCODE_SKILL_NAMES).not.toContain('collect-vault-save.mjs')
  })
})
