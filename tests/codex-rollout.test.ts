import { describe, expect, it } from 'vitest'
import { parseCodexRolloutFile, rankRolloutFiles } from '../src/main/sessions/codex-rollout'

const FILE_A =
  '/home/u/.codex/sessions/2026/06/02/rollout-2026-06-02T16-43-53-019e86a5-326e-7011-aaf3-f96de9f03e81.jsonl'
const FILE_B =
  '/home/u/.codex/sessions/2026/05/05/rollout-2026-05-05T15-55-20-019df646-aca3-70f2-bb2c-c31debf020a5.jsonl'
const FILE_C =
  '/home/u/.codex/sessions/2026/02/19/rollout-2026-02-19T22-08-44-019c7528-a891-7090-b9c5-b710011c3a49.jsonl'

describe('parseCodexRolloutFile', () => {
  it('extracts the session id and start timestamp from a rollout filename', () => {
    const ref = parseCodexRolloutFile(FILE_A)
    expect(ref).not.toBeNull()
    expect(ref?.id).toBe('019e86a5-326e-7011-aaf3-f96de9f03e81')
    expect(ref?.startedAtMs).toBe(Date.parse('2026-06-02T16:43:53'))
  })

  it('works with Windows-style backslash paths', () => {
    const ref = parseCodexRolloutFile(
      'C\\Users\\u\\.codex\\sessions\\2026\\06\\02\\rollout-2026-06-02T16-43-53-019e86a5-326e-7011-aaf3-f96de9f03e81.jsonl'
    )
    expect(ref?.id).toBe('019e86a5-326e-7011-aaf3-f96de9f03e81')
  })

  it('returns null for non-rollout jsonl files', () => {
    expect(parseCodexRolloutFile('/home/u/.codex/session_index.jsonl')).toBeNull()
    expect(parseCodexRolloutFile('/home/u/.codex/sessions/notes.jsonl')).toBeNull()
  })
})

describe('rankRolloutFiles', () => {
  it('orders files newest-first and applies the limit', () => {
    const ranked = rankRolloutFiles([FILE_B, FILE_A, FILE_C], 2)
    expect(ranked.map((ref) => ref.id)).toEqual([
      '019e86a5-326e-7011-aaf3-f96de9f03e81', // 2026-06-02
      '019df646-aca3-70f2-bb2c-c31debf020a5' // 2026-05-05
    ])
  })

  it('discovers recent sessions regardless of session_index.jsonl contents', () => {
    // The June 2 session is absent from the (frozen) index but must still rank.
    const ranked = rankRolloutFiles([FILE_C, FILE_A], 10)
    expect(ranked[0].id).toBe('019e86a5-326e-7011-aaf3-f96de9f03e81')
  })

  it('drops files that are not rollout transcripts', () => {
    const ranked = rankRolloutFiles([FILE_A, '/home/u/.codex/session_index.jsonl'], 10)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].id).toBe('019e86a5-326e-7011-aaf3-f96de9f03e81')
  })
})
