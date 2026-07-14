import { useEffect, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { OpenCodeSlimUpdateStatus } from '@shared/opencode-slim-updates'
import { PLATFORM_CONFIG } from '@shared/platform'
import './opencode-slim-update-banner.css'

const OPENCODE_ACCENT_VARS = {
  '--accent': PLATFORM_CONFIG.opencode.accent,
  '--accent-dim': PLATFORM_CONFIG.opencode.accentDim,
  '--accent-hover': PLATFORM_CONFIG.opencode.accentHover
} as CSSProperties

function CloseIcon(): JSX.Element {
  return (
    <svg className="slim-update-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

function UpdateIcon(): JSX.Element {
  return (
    <svg className="slim-update-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
    </svg>
  )
}

function noticeKey(status: OpenCodeSlimUpdateStatus): string {
  return `${status.phase}:${status.latestVersion ?? ''}:${status.detail ?? ''}`
}

export function OpenCodeSlimUpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<OpenCodeSlimUpdateStatus | null>(null)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.dashboard.openCode
      .getSlimUpdateStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => undefined)
    const remove = window.dashboard.openCode.onSlimUpdateStatusChanged(setStatus)
    return () => {
      cancelled = true
      remove()
    }
  }, [])

  const visible = status
    ? status.phase === 'error'
      ? status.latestVersion !== null
      : status.phase === 'major-update-available' ||
        status.phase === 'installing' ||
        status.phase === 'installed' ||
        status.phase === 'cadence-update-required'
    : false

  const install = (): void => {
    window.dashboard.openCode
      .installSlimMajorUpdate()
      .then(setStatus)
      .catch((error: unknown) => {
        setStatus((current) =>
          current
            ? {
                ...current,
                phase: 'error',
                detail: error instanceof Error ? error.message : 'Slim update failed'
              }
            : current
        )
      })
  }

  if (!visible || !status || dismissedKey === noticeKey(status)) return null

  const installing = status.phase === 'installing'
  const canInstall = status.phase === 'major-update-available' || status.phase === 'error'
  const label =
    status.phase === 'cadence-update-required'
      ? `Cadence update required for Slim ${status.latestVersion}`
      : status.phase === 'installed'
        ? `Slim ${status.latestVersion} is ready`
        : status.phase === 'installing'
          ? `Validating Slim ${status.latestVersion}`
          : `Slim ${status.latestVersion} is available`

  return (
    <section
      className="slim-update-banner"
      style={OPENCODE_ACCENT_VARS}
      data-phase={status.phase}
      role={status.phase === 'cadence-update-required' || status.phase === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="slim-update-copy">
        <strong>{label}</strong>
        {status.detail ? <span>{status.detail}</span> : null}
      </div>
      <div className="slim-update-actions">
        {canInstall ? (
          <button type="button" className="slim-update-install" onClick={install} disabled={installing}>
            <UpdateIcon />
            <span>{status.phase === 'error' ? 'Retry validation' : 'Validate & install'}</span>
          </button>
        ) : null}
        {installing ? <span className="slim-update-progress">Checking agents...</span> : null}
        {!installing ? (
          <button
            type="button"
            className="slim-update-dismiss"
            onClick={() => setDismissedKey(noticeKey(status))}
            aria-label="Dismiss Slim update notice"
            title="Dismiss"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
    </section>
  )
}
