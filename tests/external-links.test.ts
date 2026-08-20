import { describe, expect, it } from 'vitest'
import { normalizeExternalHttpUrl } from '../src/shared/external-links'

describe('normalizeExternalHttpUrl', () => {
  it('accepts and normalizes HTTP and HTTPS URLs', () => {
    expect(normalizeExternalHttpUrl('https://claude.ai/code')).toBe('https://claude.ai/code')
    expect(normalizeExternalHttpUrl('http://localhost:5173/path')).toBe('http://localhost:5173/path')
  })

  it('rejects non-web protocols and malformed values', () => {
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalHttpUrl('file:///C:/secrets.txt')).toBeNull()
    expect(normalizeExternalHttpUrl('not a url')).toBeNull()
    expect(normalizeExternalHttpUrl(null)).toBeNull()
  })

  it('rejects URLs containing embedded credentials', () => {
    expect(normalizeExternalHttpUrl('https://user:password@example.com/private')).toBeNull()
  })
})
