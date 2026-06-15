import { describe, expect, it } from 'vitest'
import {
  buildSessionTitlePrompt,
  compactSessionTitleDigest,
  parseSessionTitleGenerationOutput,
  validateGeneratedSessionTitle
} from '../src/main/sessions/session-title-ai'

describe('validateGeneratedSessionTitle', () => {
  it('accepts compact workstream titles', () => {
    expect(validateGeneratedSessionTitle('Dashboard Session Title Cleanup')).toBe('Dashboard Session Title Cleanup')
    expect(validateGeneratedSessionTitle('scope questionnaire drafting')).toBe('Scope Questionnaire Drafting')
  })

  it('rejects command fragments, paths, and response fragments', () => {
    expect(validateGeneratedSessionTitle('Run the [$save](C:\\Users\\sheld\\.codex\\skills\\save\\SKILL.md)')).toBeNull()
    expect(validateGeneratedSessionTitle("I've reviewed the document and I'm")).toBeNull()
    expect(validateGeneratedSessionTitle('Just Pnpm Which Likely Improvements')).toBeNull()
  })
})

describe('compactSessionTitleDigest', () => {
  it('keeps early context and recent work inside the character budget', () => {
    const digest = compactSessionTitleDigest(
      Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `Entry ${index} ${'x'.repeat(120)}`,
        timestampMs: index
      })),
      1600
    )

    expect(digest.entries[0]?.text).toContain('Entry 0')
    expect(digest.entries.some((entry) => entry.text.includes('Entry 39'))).toBe(true)
    expect(digest.omittedEntryCount).toBeGreaterThan(0)
    expect(digest.charCount).toBeLessThanOrEqual(1600)
  })
})

describe('buildSessionTitlePrompt', () => {
  it('includes previous title context for delta updates', () => {
    const prompt = buildSessionTitlePrompt({
      platform: 'codex',
      project: 'ai-dashboard',
      projectPath: 'C:/repo/ai-dashboard',
      branch: 'fix/session-title-quality',
      fallbackTitle: 'Codex 019abc',
      heuristicTitle: 'General Improvements',
      rawTitle: null,
      inferredTitle: 'General Improvements',
      previousTitle: 'Dashboard Session Title Cleanup',
      previousSummary: 'Worked on improving dashboard session titles.',
      mode: 'delta',
      transcriptUpdatedAt: '2026-06-12T00:00:00.000Z',
      digest: {
        entries: [{ role: 'user', text: 'The current title still does not describe the dashboard work.', timestampMs: 1 }],
        omittedEntryCount: 0,
        charCount: 64
      }
    })

    expect(prompt).toContain('"mode": "delta"')
    expect(prompt).toContain('Dashboard Session Title Cleanup')
    expect(prompt).toContain('Worked on improving dashboard session titles.')
  })
})

describe('parseSessionTitleGenerationOutput', () => {
  it('parses and normalizes structured title output', () => {
    expect(
      parseSessionTitleGenerationOutput(
        JSON.stringify({
          title: 'scope questionnaire drafting',
          summary: 'Worked on the Badisa scope questionnaire document.',
          shouldUpdate: true,
          confidence: 0.9,
          reason: 'The questionnaire was the main artifact.'
        })
      )
    ).toMatchObject({
      title: 'Scope Questionnaire Drafting',
      shouldUpdate: true,
      confidence: 0.9
    })
  })

  it('rejects invalid provider titles', () => {
    expect(
      parseSessionTitleGenerationOutput(
        JSON.stringify({
          title: 'Just Pnpm Which Likely Improvements',
          summary: 'Bad title.',
          shouldUpdate: true,
          confidence: 0.2,
          reason: 'Invalid.'
        })
      )
    ).toBeNull()
  })
})
