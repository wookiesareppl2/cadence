import { describe, expect, it } from 'vitest'
import { confineRelPath, isValidEntryName, joinNative, toNativeRoot } from '../src/shared/project-files'

describe('confineRelPath', () => {
  it('cleans ordinary relative paths and keeps spaces', () => {
    expect(confineRelPath('')).toBe('')
    expect(confineRelPath('src')).toBe('src')
    expect(confineRelPath('src/app.tsx')).toBe('src/app.tsx')
    expect(confineRelPath('src\\nested\\file.ts')).toBe('src/nested/file.ts')
    expect(confineRelPath('My Folder/My File.txt')).toBe('My Folder/My File.txt')
    expect(confineRelPath('a//b/./c')).toBe('a/b/c')
  })

  it('rejects upward traversal', () => {
    expect(confineRelPath('..')).toBeNull()
    expect(confineRelPath('../etc')).toBeNull()
    expect(confineRelPath('src/../../secret')).toBeNull()
    expect(confineRelPath('a/b/../../../c')).toBeNull()
  })

  it('collapses absolute-looking input into harmless relative segments', () => {
    // Leading slashes are stripped, so these stay inside the root rather than escaping.
    expect(confineRelPath('/etc/passwd')).toBe('etc/passwd')
    expect(confineRelPath('C:/Windows')).toBe('C:/Windows')
  })

  it('rejects non-strings', () => {
    expect(confineRelPath(null)).toBeNull()
    expect(confineRelPath(undefined)).toBeNull()
    expect(confineRelPath(42)).toBeNull()
  })
})

describe('isValidEntryName', () => {
  it('accepts plain names including spaces and dots', () => {
    expect(isValidEntryName('file.ts')).toBe(true)
    expect(isValidEntryName('My File.txt')).toBe(true)
    expect(isValidEntryName('.env')).toBe(true)
  })

  it('rejects separators, traversal, and empties', () => {
    expect(isValidEntryName('a/b')).toBe(false)
    expect(isValidEntryName('a\\b')).toBe(false)
    expect(isValidEntryName('..')).toBe(false)
    expect(isValidEntryName('.')).toBe(false)
    expect(isValidEntryName('   ')).toBe(false)
    expect(isValidEntryName('')).toBe(false)
    expect(isValidEntryName(null)).toBe(false)
  })
})

describe('toNativeRoot', () => {
  it('translates a WSL POSIX root to the wsl.localhost UNC share', () => {
    expect(toNativeRoot('/home/user/app', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\app')
    expect(toNativeRoot('/srv/site/', 'Debian')).toBe('\\\\wsl.localhost\\Debian\\srv\\site')
  })

  it('normalizes a native Windows root', () => {
    expect(toNativeRoot('C:\\Projects\\app', null)).toBe('C:\\Projects\\app')
    expect(toNativeRoot('C:/Projects/app/', null)).toBe('C:\\Projects\\app')
  })
})

describe('joinNative', () => {
  it('appends a confined relative path with native separators', () => {
    expect(joinNative('C:\\Projects\\app', '')).toBe('C:\\Projects\\app')
    expect(joinNative('C:\\Projects\\app', 'src/app.tsx')).toBe('C:\\Projects\\app\\src\\app.tsx')
    expect(joinNative('\\\\wsl.localhost\\Ubuntu\\home\\app', 'src/x')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\app\\src\\x'
    )
  })
})
