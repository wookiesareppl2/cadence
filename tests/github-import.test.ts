import { describe, expect, it } from 'vitest'
import {
  defaultGitHubDirectoryName,
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
