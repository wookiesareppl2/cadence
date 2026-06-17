import { describe, expect, it } from 'vitest'
import {
  isProjectWorkspaceEmpty,
  MAX_NOTES_LENGTH,
  MAX_TASKS,
  MAX_TASK_TEXT_LENGTH,
  projectWorkspaceKey,
  sanitizeProjectWorkspace
} from '../src/shared/project-workspace'

describe('sanitizeProjectWorkspace', () => {
  it('returns an empty workspace for non-objects', () => {
    expect(sanitizeProjectWorkspace(null)).toEqual({ notes: '', tasks: [] })
    expect(sanitizeProjectWorkspace('nope')).toEqual({ notes: '', tasks: [] })
    expect(sanitizeProjectWorkspace(undefined)).toEqual({ notes: '', tasks: [] })
  })

  it('keeps valid notes and tasks, coercing types', () => {
    const result = sanitizeProjectWorkspace({
      notes: 'remember to run pnpm dev',
      tasks: [
        { id: 'a', text: 'Wire up usage poll', done: false, createdAt: 1000 },
        { id: 'b', text: 'Fix WSL paths', done: 'yes', createdAt: 'bad' }
      ]
    })

    expect(result.notes).toBe('remember to run pnpm dev')
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0]).toEqual({ id: 'a', text: 'Wire up usage poll', done: false, createdAt: 1000 })
    // `done` only true for a literal true; a non-number createdAt is replaced.
    expect(result.tasks[1].done).toBe(false)
    expect(typeof result.tasks[1].createdAt).toBe('number')
  })

  it('drops malformed task entries', () => {
    const result = sanitizeProjectWorkspace({
      tasks: [null, 'x', { id: 'ok', text: 'keep me' }, { id: 1, text: 'no id' }, { id: 'z' }]
    })
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]?.id).toBe('ok')
  })

  it('clamps notes length and task text length and caps task count', () => {
    const result = sanitizeProjectWorkspace({
      notes: 'x'.repeat(MAX_NOTES_LENGTH + 50),
      tasks: Array.from({ length: MAX_TASKS + 10 }, (_, i) => ({
        id: `t${i}`,
        text: 'y'.repeat(MAX_TASK_TEXT_LENGTH + 5),
        done: false,
        createdAt: i
      }))
    })

    expect(result.notes).toHaveLength(MAX_NOTES_LENGTH)
    expect(result.tasks).toHaveLength(MAX_TASKS)
    expect(result.tasks[0]?.text).toHaveLength(MAX_TASK_TEXT_LENGTH)
  })
})

describe('projectWorkspaceKey', () => {
  it('drops the platform prefix so Claude and Codex share one key per directory', () => {
    expect(projectWorkspaceKey('claude:c:\\projects\\app')).toBe('c:\\projects\\app')
    expect(projectWorkspaceKey('codex:c:\\projects\\app')).toBe('c:\\projects\\app')
    // Both AI models for the same folder map to the same key.
    expect(projectWorkspaceKey('claude:c:\\projects\\app')).toBe(projectWorkspaceKey('codex:c:\\projects\\app'))
  })

  it('keeps the WSL origin namespace (only the leading platform is stripped)', () => {
    expect(projectWorkspaceKey('claude:wsl:Ubuntu:/home/user/app')).toBe('wsl:Ubuntu:/home/user/app')
    expect(projectWorkspaceKey('codex:wsl:Ubuntu:/home/user/app')).toBe('wsl:Ubuntu:/home/user/app')
  })

  it('passes through ids without a platform prefix unchanged', () => {
    expect(projectWorkspaceKey('c:\\projects\\app')).toBe('c:\\projects\\app')
  })
})

describe('isProjectWorkspaceEmpty', () => {
  it('is true only when there are no tasks and blank notes', () => {
    expect(isProjectWorkspaceEmpty({ notes: '', tasks: [] })).toBe(true)
    expect(isProjectWorkspaceEmpty({ notes: '   \n ', tasks: [] })).toBe(true)
    expect(isProjectWorkspaceEmpty({ notes: 'hi', tasks: [] })).toBe(false)
    expect(isProjectWorkspaceEmpty({ notes: '', tasks: [{ id: 'a', text: 'x', done: false, createdAt: 1 }] })).toBe(false)
  })
})
