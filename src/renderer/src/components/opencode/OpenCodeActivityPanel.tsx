import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { OpenCodeActivitySnapshot } from '@shared/opencode'
import './opencode-activity-panel.css'

const ACTIVITY_POLL_MS = 2_500

function costLabel(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '--'
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
}

function modelLabel(model: string | null): string {
  return model?.replace(/^opencode-go\//, '') ?? 'Awaiting model'
}

export function OpenCodeActivityPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const [open, setOpen] = useState(true)
  const [snapshot, setSnapshot] = useState<OpenCodeActivitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      setSnapshot(await window.dashboard.openCode.getActivity(sessionId))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Activity unavailable')
    }
  }, [sessionId])

  useEffect(() => {
    setSnapshot(null)
    setError(null)
    if (!sessionId) return
    void refresh()
    const id = window.setInterval(refresh, ACTIVITY_POLL_MS)
    return () => window.clearInterval(id)
  }, [refresh, sessionId])

  const summary = !sessionId
    ? 'Select a session'
    : error
      ? 'Unavailable'
      : snapshot
        ? `${snapshot.jobs.length} ${snapshot.jobs.length === 1 ? 'agent' : 'agents'} · ${snapshot.pendingTodos} pending`
        : 'Checking activity'

  return (
    <section className={`panel opencode-activity ${open ? 'expanded' : 'collapsed'}`} aria-label="OpenCode agents">
      <button
        type="button"
        className="opencode-activity-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={open ? 'Hide agent activity' : 'Show agent activity'}
      >
        <span className="opencode-activity-title">Agent Activity</span>
        <span className="opencode-activity-summary">{summary}</span>
        <span className="opencode-activity-chevron" aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
      <div className="collapsible-content" data-open={open} aria-hidden={!open}>
        <div className="collapsible-inner">
          <div className="opencode-activity-body">
            {!sessionId ? (
              <span className="opencode-activity-empty">Select an OpenCode session.</span>
            ) : error ? (
              <span className="opencode-activity-error">{error}</span>
            ) : !snapshot ? (
              <span className="opencode-activity-empty">Loading activity...</span>
            ) : snapshot.jobs.length === 0 ? (
              <span className="opencode-activity-empty">
                {snapshot.pendingTodos > 0 ? `${snapshot.pendingTodos} tasks queued` : 'No background agents'}
              </span>
            ) : (
              <div className="opencode-activity-jobs">
                {snapshot.jobs.map((job) => (
                  <div className="opencode-activity-job" key={job.sessionId}>
                    <span className="opencode-activity-status" data-status={job.status} aria-label={job.status} />
                    <span className="opencode-activity-agent">{job.agent ?? 'subagent'}</span>
                    <span className="opencode-activity-job-title" title={job.title}>{job.title}</span>
                    <span className="opencode-activity-model" title={job.model ?? undefined}>{modelLabel(job.model)}</span>
                    <span className="opencode-activity-cost">{costLabel(job.cost)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
