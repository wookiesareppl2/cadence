import { describe, expect, it } from 'vitest'
import { cleanHistoryText } from '../src/main/sessions/session-history-text'

describe('session history text cleanup', () => {
  it('extracts the Codex IDE request body without environment context', () => {
    const text = [
      '# Context from my IDE setup:',
      '<environment_context>',
      '  <cwd>C:\\Project</cwd>',
      '</environment_context>',
      '',
      '## My request for Codex:',
      'Please make the transcript easier to scan.'
    ].join('\n')

    expect(cleanHistoryText(text, { commandPrefix: '/' })).toBe('Please make the transcript easier to scan.')
  })

  it('turns a Claude skill injection into the typed command fallback', () => {
    const text = [
      '<skill>',
      '<name>start</name>',
      '<description>Resume a project session.</description>',
      '<body>Long setup instructions that should not be shown as a user prompt.</body>',
      '</skill>'
    ].join('\n')

    expect(cleanHistoryText(text, { commandPrefix: '$' })).toBe('$start')
  })

  it('turns a Codex skill injection into the typed command fallback', () => {
    const text = [
      '<skill>',
      '<name>start</name>',
      '<description>Resume a project session.</description>',
      '</skill>'
    ].join('\n')

    expect(cleanHistoryText(text, { commandPrefix: '/' })).toBe('/start')
  })

  it('removes injected skill content while keeping the surrounding user request', () => {
    const text = [
      'Can you continue with the visual polish?',
      '<skill>',
      '<name>start</name>',
      '<body>Injected setup instructions.</body>',
      '</skill>'
    ].join('\n')

    expect(cleanHistoryText(text, { commandPrefix: '$' })).toBe('Can you continue with the visual polish?')
  })

  it('uses command-name when the visible text was only command scaffolding', () => {
    const text = [
      '<command-name>start</command-name>',
      '<command-message>Loaded the start skill and injected setup instructions.</command-message>'
    ].join('\n')

    expect(cleanHistoryText(text, { commandPrefix: '$' })).toBe('$start')
  })

  it('drops command output when there is no user command to recover', () => {
    expect(cleanHistoryText('<local-command-stdout>Tool output only.</local-command-stdout>')).toBeNull()
  })
})
