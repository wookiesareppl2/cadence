import { describe, expect, it } from 'vitest'
import { resolveSessionTitle, titleCandidate } from '../src/main/sessions/session-title'

describe('session title resolver', () => {
  it('uses a focused theme when one session area dominates', () => {
    const result = resolveSessionTitle({
      rawTitle: '$start',
      fallbackTitle: 'cadence',
      messages: [
        { text: '$start', timestampMs: 1 },
        {
          text: 'I realized that when I start a new session, all the session titles will be similar. Do you have any suggestions to improve the session titles?',
          timestampMs: 2
        },
        {
          text: 'The issue with this approach is that I can work on various different things within a session, so session titles need to depict the session overall.',
          timestampMs: 3
        },
        {
          text: 'Will this add significant token usage to the overall use of the program?',
          timestampMs: 4
        },
        { text: 'Proceed as suggested', timestampMs: 3 }
      ]
    })

    expect(result.title).toBe('Session Display Improvements')
    expect(result.inferredTitle).toBe('Session Display Improvements')
  })

  it('uses a general title when the session spans unrelated work areas', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'cadence',
      messages: [
        { text: 'Please improve the session titles so they explain the overall work better.', timestampMs: 1 },
        { text: 'Can you also theme the scrollbars and clean up the visual elements?', timestampMs: 2 },
        { text: 'The Claude usage notifications keep popping up every few minutes near the usage limit.', timestampMs: 3 },
        { text: 'Now the test run is failing with a TypeScript error that we need to fix.', timestampMs: 4 }
      ]
    })

    expect(result.title).toBe('General Improvements')
    expect(result.inferredTitle).toBe('General Improvements')
  })

  it('keeps a focused title when one area dominates over a minor workflow note', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'cadence',
      messages: [
        { text: 'Please improve the session titles so they explain the overall work better.', timestampMs: 1 },
        { text: 'The session title display still needs to avoid weak sentence fragments.', timestampMs: 2 },
        { text: 'Once I am done implementing various fixes, I will ask you to package the app update.', timestampMs: 3 }
      ]
    })

    expect(result.title).toBe('Session Display Improvements')
    expect(result.inferredTitle).toBe('Session Display Improvements')
  })

  it('extracts Codex IDE request blocks before inferring the title', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019979e6',
      messages: [
        {
          text: '# Context from my IDE setup:\n\n## Active file: Portfolio.tsx\n\n## My request for Codex:\nI need help fixing the image hover animation in my React/TypeScript portfolio component.',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Fix Image Hover Animation')
  })

  it('falls back to the raw title when no better inferred title exists', () => {
    const result = resolveSessionTitle({
      rawTitle: 'Existing provider title',
      fallbackTitle: 'Claude session',
      messages: [{ text: '/start', timestampMs: 1 }]
    })

    expect(result.title).toBe('Existing provider title')
    expect(result.rawTitle).toBe('Existing provider title')
    expect(result.inferredTitle).toBeNull()
  })

  it('keeps code review titles terse without including pasted diffs', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Claude session',
      messages: [
        {
          text: 'Review this change for security vulnerabilities.\n\nChanged files:\n- src/main/index.ts\n\nUnified diff\n@@ -1 +1 @@',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Security Review')
  })

  it('ignores subagent notifications when inferring a title', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ea57d',
      messages: [
        {
          text: 'Can you please investigate the duplicate Codex sessions in the cadence project?',
          timestampMs: 1
        },
        {
          text:
            '<subagent_notification>\n' +
            '{"agent_path":"019e8c08-a9c8-78e1-8b6e-6f276ef0665f","status":{"completed":"Done"}}\n' +
            '</subagent_notification>',
          timestampMs: 2
        }
      ]
    })

    expect(result.title).toBe('Codex Session Filtering')
    expect(result.inferredTitle).toBe('Codex Session Filtering')
  })

  it('falls back when only subagent notifications are available', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ea57d',
      messages: [
        {
          text:
            '<subagent_notification>\n' +
            '{"agent_path":"019e8c08-a9c8-78e1-8b6e-6f276ef0665f","status":{"completed":"Done"}}\n' +
            '</subagent_notification>',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Codex 019ea57d')
    expect(result.inferredTitle).toBeNull()
  })

  it('ignores weak raw provider titles when no inferred title exists', () => {
    const result = resolveSessionTitle({
      rawTitle: 'Once I am done implementing various fixes,',
      fallbackTitle: 'Claude session',
      messages: [{ text: 'Proceed as suggested', timestampMs: 1 }]
    })

    expect(result.title).toBe('Claude session')
    expect(result.rawTitle).toBeNull()
    expect(result.inferredTitle).toBeNull()
  })

  it('ignores negative raw provider fragments when no inferred title exists', () => {
    const result = resolveSessionTitle({
      rawTitle: "I don't want to address any",
      fallbackTitle: 'Claude session',
      messages: [{ text: 'Proceed as suggested', timestampMs: 1 }]
    })

    expect(result.title).toBe('Claude session')
    expect(result.rawTitle).toBeNull()
    expect(result.inferredTitle).toBeNull()
  })

  it('rejects injected environment, skill, and instruction blocks as title candidates', () => {
    expect(titleCandidate('<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>')).toBeNull()
    expect(titleCandidate('<skill>\n<name>start</name>\n<path>SKILL.md</path>\n</skill>')).toBeNull()
    expect(titleCandidate('<user_instructions>do the thing</user_instructions>')).toBeNull()
    // A genuine prompt is still accepted.
    expect(titleCandidate('Please theme the terminal scrollbars')).toBe('Please theme the terminal scrollbars')
  })

  it('labels a pure save-skill session "Save Session"', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        { text: 'You are the single delegated worker required by the save skill. Do not deviate.', timestampMs: 1 },
        { text: 'Run the `save` skill in Memory Bank mode for this repo exactly as specified.', timestampMs: 2 }
      ]
    })

    expect(result.title).toBe('Save Session')
    expect(result.inferredTitle).toBeNull()
  })

  it('labels markdown-linked save command sessions "Save Session"', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        {
          text: 'Run the [$save](C:\\Users\\sheld\\.codex\\skills\\save\\SKILL.md) skill exactly as specified.',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Save Session')
    expect(result.inferredTitle).toBeNull()
  })

  it('labels a pure start-skill session "Session Start"', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        { text: '$start', timestampMs: 1 },
        { text: 'You are the single delegated worker for the `start` skill. Workspace root: c:/repo', timestampMs: 2 }
      ]
    })

    expect(result.title).toBe('Session Start')
    expect(result.inferredTitle).toBeNull()
  })

  it('keeps a meaningful provider title over a workflow label', () => {
    const result = resolveSessionTitle({
      rawTitle: 'Investigate flaky deploy',
      fallbackTitle: 'Codex 019ab123',
      messages: [{ text: '$save', timestampMs: 1 }]
    })

    expect(result.title).toBe('Investigate flaky deploy')
  })

  it('breaks a start/save tie by the workflow that appears first', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        { text: '$start', timestampMs: 1 },
        { text: 'Run the save skill for this repo', timestampMs: 2 }
      ]
    })

    expect(result.title).toBe('Session Start')
  })

  it('still falls back to provider id when no workflow markers are present', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [{ text: 'Proceed as suggested', timestampMs: 1 }]
    })

    expect(result.title).toBe('Codex 019ab123')
  })

  it('surfaces the real request even when a skill worker prompt precedes it', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        { text: 'You are the single delegated worker for the /start skill. Workspace root: c:/repo', timestampMs: 1 },
        { text: 'Please improve the usage bars and usage display meters on the dashboard.', timestampMs: 2 }
      ]
    })

    expect(result.title).toBe('Usage Display Improvements')
    expect(result.inferredTitle).toBe('Usage Display Improvements')
  })

  it('does not use reviewed-document status preambles as compact titles', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        {
          text: "I've reviewed the document and I'm ready to provide it to you to review my comments and implement any suggested improvements.",
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Codex 019ab123')
    expect(result.inferredTitle).toBeNull()
  })

  it('titles Google Docs connector access prompts by topic instead of the opening status sentence', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        {
          text:
            '# Context from my IDE setup:\n\n' +
            '## Active file: BADISA_PHASE_1_SCOPE_QUESTIONNAIRE_2026-04-24.md\n\n' +
            '## My request for Codex:\n' +
            "I've reviewed the document and I'm ready to provide it to you to review my comments and implement any suggested improvements. " +
            'Before you do anything, please confirm how exactly the process works in terms of how you are able to access the Google doc via the connector?',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Google Docs Connector Access')
    expect(result.inferredTitle).toBe('Google Docs Connector Access')
  })

  it('prefers the scope questionnaire workstream over a Google Docs access detour', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        {
          text:
            'We already reworked the BADISA_PHASE_1_SCOPE_QUESTIONNAIRE document and need to look for any issues or changes needed in the questionaire.',
          timestampMs: 1
        },
        {
          text:
            "I've reviewed the document and I'm ready to provide it to you to review my comments. " +
            'Before you do anything, please confirm how exactly the process works in terms of how you are able to access the Google doc via the connector?',
          timestampMs: 2
        },
        {
          text:
            'Please proceed with creating a revised v5 scope questionaire that includes the suggested improvements.',
          timestampMs: 3
        }
      ]
    })

    expect(result.title).toBe('Scope Questionnaire Review')
    expect(result.inferredTitle).toBe('Scope Questionnaire Review')
  })

  it('tolerates small spelling errors in topic words', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        {
          text: 'The Claude usage notificatons keep popping up every few minutes and need to be fixed.',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Usage Notification Improvements')
    expect(result.inferredTitle).toBe('Usage Notification Improvements')
  })

  it('derives a workstream title from repeated document artifact names', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ab123',
      messages: [
        {
          text:
            '# Context from my IDE setup:\n\n' +
            '## Active file: PRODUCT_REQUIREMENTS_BRIEF_2026-06-01.md\n\n' +
            '## My request for Codex:\nCan you review the document and check whether anything important is missing?',
          timestampMs: 1
        },
        {
          text:
            '# Context from my IDE setup:\n\n' +
            '## Active file: PRODUCT_REQUIREMENTS_BRIEF_2026-06-01.md\n\n' +
            '## My request for Codex:\nPlease update the requirements brief based on the review findings.',
          timestampMs: 2
        }
      ]
    })

    expect(result.title).toBe('Requirements Brief Review')
    expect(result.inferredTitle).toBe('Requirements Brief Review')
  })
})
