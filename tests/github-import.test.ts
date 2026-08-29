import { describe, expect, it } from 'vitest'
import {
  defaultGitHubDirectoryName,
  formatGitError,
  normalizedGitHubCloneUrl,
  parseGitHubRepository
} from '../src/shared/github-import'

describe('parseGitHubRepository', () => {
  it('parses HTTPS GitHub repository URLs', () => {
    expect(parseGitHubRepository('https://github.com/openai/codex.git')).toEqual({
      host: 'github.com',
      owner: 'openai',
      repo: 'codex',
      repoName: 'codex',
      key: 'github.com__openai__codex'
    })
  })

  it('parses SSH and owner/repo shorthand', () => {
    expect(parseGitHubRepository('git@github.com:Owner/My-App.git')?.key).toBe('github.com__owner__my-app')
    expect(parseGitHubRepository('Owner/My-App')?.repoName).toBe('My-App')
  })

  it('rejects non-GitHub or malformed values', () => {
    expect(parseGitHubRepository('https://gitlab.com/openai/codex')).toBeNull()
    expect(parseGitHubRepository('github.com/openai')).toBeNull()
    expect(parseGitHubRepository('not a url')).toBeNull()
  })
})

describe('defaultGitHubDirectoryName', () => {
  it('uses the repository name when the input parses', () => {
    expect(defaultGitHubDirectoryName('https://github.com/openai/codex.git')).toBe('codex')
  })

  it('returns an empty string for invalid input', () => {
    expect(defaultGitHubDirectoryName('')).toBe('')
  })
})

describe('normalizedGitHubCloneUrl', () => {
  it('turns shorthand and browser URLs into cloneable HTTPS URLs', () => {
    expect(normalizedGitHubCloneUrl('openai/codex')).toBe('https://github.com/openai/codex.git')
    expect(normalizedGitHubCloneUrl('https://github.com/openai/codex/issues')).toBe(
      'https://github.com/openai/codex.git'
    )
  })

  it('keeps SSH clone URLs unchanged', () => {
    expect(normalizedGitHubCloneUrl('git@github.com:openai/codex.git')).toBe('git@github.com:openai/codex.git')
  })
})

// Git is the one external program Cadence needs but does not bundle, so this is
// the message a user on a clean Windows PC sees. It cannot be reached by testing
// on a machine that HAS git, which is exactly why it is pinned here.
describe('formatGitError', () => {
  it('names Git and the fix when the binary is missing', () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    const message = formatGitError(enoent, 'Could not sync the context vault.')
    expect(message).toContain('Git is not installed')
    // The raw spawn text must not survive — it is what made the old message useless.
    expect(message).not.toContain('ENOENT')
    expect(message).not.toContain('spawn')
  })

  // A command that RAN and failed carries the only text that explains why. Treating
  // every failure as "git is missing" would hide "repository not found" behind advice
  // to install software the user already has.
  it('passes through the real stderr of a command that ran and failed', () => {
    const failed = Object.assign(new Error('Command failed'), {
      code: 128,
      stderr: 'remote: Repository not found.'
    })
    const message = formatGitError(failed, 'Could not clone.')
    expect(message).toBe('Could not clone. remote: Repository not found.')
  })

  it('falls back to the caller message when there is no detail', () => {
    expect(formatGitError({}, 'Could not clone.')).toBe('Could not clone.')
    expect(formatGitError(null, 'Could not clone.')).toBe('Could not clone.')
  })

  // An exit code that merely stringifies to ENOENT-ish must not be mistaken for a
  // missing binary; only the exact string code means the spawn itself failed.
  it('does not treat a numeric exit code as a missing binary', () => {
    const message = formatGitError({ code: 127, stderr: 'git: command failed' }, 'Could not clone.')
    expect(message).toBe('Could not clone. git: command failed')
  })
})
