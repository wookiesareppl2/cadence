export interface ExternalLinkOpenResult {
  ok: boolean
  cancelled?: boolean
  error?: string
}

const MAX_EXTERNAL_URL_LENGTH = 8_192

export function normalizeExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) return null

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
