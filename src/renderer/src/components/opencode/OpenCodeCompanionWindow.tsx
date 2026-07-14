import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type {
  OpenCodeActivitySnapshot,
  OpenCodeAgentActivity,
  OpenCodeCompanionState
} from '@shared/opencode'
import { PLATFORM_CONFIG } from '@shared/platform'
import './opencode-companion-window.css'

const ACTIVITY_POLL_MS = 2_500

type CSSVars = CSSProperties & Record<`--${string}`, string>

function modelLabel(model: string | null): string {
  return model?.replace(/^opencode-go\//, '') ?? 'Awaiting model'
}

function statusLabel(status: OpenCodeAgentActivity['status']): string {
  if (status === 'busy') return 'Working'
  if (status === 'retry') return 'Retrying'
  if (status === 'idle') return 'Idle'
  return 'Unknown'
}

function statusRank(status: OpenCodeAgentActivity['status']): number {
  if (status === 'busy') return 0
  if (status === 'retry') return 1
  if (status === 'idle') return 2
  return 3
}

function sortedJobs(snapshot: OpenCodeActivitySnapshot | null): OpenCodeAgentActivity[] {
  return [...(snapshot?.jobs ?? [])].sort((left, right) => {
    const rank = statusRank(left.status) - statusRank(right.status)
    return rank || right.updatedAt.localeCompare(left.updatedAt)
  })
}

function CloseIcon(): JSX.Element {
  return (
    <svg className="opencode-companion-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

function OpenCadenceIcon(): JSX.Element {
  return (
    <svg className="opencode-companion-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8h9M9 4.5L12.5 8 9 11.5" />
    </svg>
  )
}

export function OpenCodeCompanionWindow(): JSX.Element {
  const [state, setState] = useState<OpenCodeCompanionState | null>(null)
  const [snapshot, setSnapshot] = useState<OpenCodeActivitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionId = state?.target.sessionId ?? null
  const jobs = useMemo(() => sortedJobs(snapshot), [snapshot])
  const workingCount = jobs.filter((job) => job.status === 'busy' || job.status === 'retry').length
  const cssVars = {
    '--accent': PLATFORM_CONFIG.opencode.accent,
    '--accent-dim': PLATFORM_CONFIG.opencode.accentDim,
    '--accent-hover': PLATFORM_CONFIG.opencode.accentHover
  } as CSSVars

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      const next = await window.dashboard.openCode.getActivity(sessionId)
      setSnapshot(next)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'OpenCode activity is unavailable')
    }
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    window.dashboard.openCode
      .getCompanionState()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch(() => {
        if (!cancelled) setError('Companion state is unavailable')
      })
    const remove = window.dashboard.openCode.onCompanionStateChanged(setState)
    return () => {
      cancelled = true
      remove()
    }
  }, [])

  useEffect(() => {
    setSnapshot(null)
    setError(null)
    if (!sessionId) return
    void refresh()
    const id = window.setInterval(refresh, ACTIVITY_POLL_MS)
    return () => window.clearInterval(id)
  }, [refresh, sessionId])

  const focusCadence = useCallback(() => {
    window.dashboard.openCode.focusCompanionTarget()
  }, [])

  const closeCompanion = useCallback(() => {
    window.dashboard.openCode.setCompanionEnabled(false).catch(() => window.dashboard.window.close())
  }, [])

  const projectName = state?.target.projectName ?? 'OpenCode session'
  const summary = !sessionId
    ? 'Waiting'
    : error
      ? 'Unavailable'
      : !snapshot
        ? 'Checking'
        : workingCount > 0
          ? `${workingCount} working`
          : 'Idle'

  return (
    <main className="opencode-companion-shell" style={cssVars} data-platform="opencode">
      <header className="opencode-companion-titlebar">
        <div className="opencode-companion-heading">
          <span className="opencode-companion-mark" aria-hidden="true">C</span>
          <span>OpenCode Companion</span>
        </div>
        <span className="opencode-companion-summary" data-working={workingCount > 0}>{summary}</span>
        <button type="button" className="opencode-companion-close" onClick={closeCompanion} aria-label="Turn off Companion" title="Turn off Companion">
          <CloseIcon />
        </button>
      </header>

      <div className="opencode-companion-context">
        <span className="opencode-companion-project" title={projectName}>{projectName}</span>
        {snapshot && snapshot.pendingTodos > 0 ? (
          <span className="opencode-companion-todos">{snapshot.pendingTodos} pending</span>
        ) : null}
      </div>

      <section className="opencode-companion-body" aria-label="OpenCode agent activity">
        {!state ? (
          <span className="opencode-companion-empty">Loading activity...</span>
        ) : !sessionId ? (
          <span className="opencode-companion-empty">Select an OpenCode session in Cadence.</span>
        ) : error ? (
          <span className="opencode-companion-error">{error}</span>
        ) : !snapshot ? (
          <span className="opencode-companion-empty">Checking agent activity...</span>
        ) : jobs.length === 0 ? (
          <span className="opencode-companion-empty">
            {snapshot.pendingTodos > 0 ? `${snapshot.pendingTodos} tasks queued` : 'No background agents'}
          </span>
        ) : (
          <div className="opencode-companion-jobs">
            {jobs.map((job) => (
              <button
                key={job.sessionId}
                type="button"
                className="opencode-companion-job"
                onClick={focusCadence}
                title="Open this session in Cadence"
              >
                <span className="opencode-companion-status" data-status={job.status} aria-hidden="true" />
                <span className="opencode-companion-agent">@{job.agent ?? 'subagent'}</span>
                <span className="opencode-companion-task" title={job.title}>{job.title}</span>
                <span className="opencode-companion-model" title={job.model ?? undefined}>{modelLabel(job.model)}</span>
                <span className="opencode-companion-state">{statusLabel(job.status)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <footer className="opencode-companion-footer">
        <button type="button" onClick={focusCadence} disabled={!sessionId}>
          <OpenCadenceIcon />
          <span>Open in Cadence</span>
        </button>
      </footer>
    </main>
  )
}
