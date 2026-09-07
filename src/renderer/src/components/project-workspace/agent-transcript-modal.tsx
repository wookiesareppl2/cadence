import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AgentRun } from '@shared/agent-activity'
import type { AssistantSessionHistoryEntry } from '@shared/sessions'
import { HistoryEntryArticle } from '../history-entry-view'

// Reads one agent's own transcript. It follows the app's modal rules — fixed below
// the titlebar, backdrop click and Esc both close — and renders turns through the
// same component the History panel uses, so an agent's work reads exactly like a
// session's.
//
// A live run's transcript keeps growing, so this re-reads on the same cadence the
// list does while the run is still going, and stops once it is not.
const LIVE_REFRESH_MS = 4_000

export function AgentTranscriptModal({ run, onClose }: { run: AgentRun; onClose: () => void }): JSX.Element {
  const [entries, setEntries] = useState<AssistantSessionHistoryEntry[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setEntries([])
    setReady(false)

    const load = async (): Promise<void> => {
      try {
        const result = await window.dashboard.agents.transcript(run.platform, run.transcriptPath)
        if (!cancelled) setEntries(result)
      } catch {
        // Leave the last good transcript up rather than blanking it.
      } finally {
        if (!cancelled) setReady(true)
      }
    }

    void load()
    if (run.status !== 'running') return () => {
      cancelled = true
    }

    const timer = window.setInterval(() => void load(), LIVE_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [run.platform, run.transcriptPath, run.status])

  return (
    <div
      className="agent-transcript-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="agent-transcript-modal" role="dialog" aria-modal="true" aria-label={`${run.label} transcript`}>
        <header className="agent-transcript-header">
          <div className="agent-transcript-heading">
            <span className="agent-transcript-title">{run.label}</span>
            <span className="agent-transcript-sub">
              {[run.role, run.agentPath, `${run.turnCount} turns`].filter(Boolean).join(' · ')}
            </span>
          </div>
          <span className={`workspace-agent-status status-${run.status}`}>{run.status}</span>
          <button type="button" className="agent-transcript-close" onClick={onClose} aria-label="Close transcript">
            ✕
          </button>
        </header>
        {run.errorMessage ? <div className="agent-transcript-error">{run.errorMessage}</div> : null}
        <div className="agent-transcript-feed">
          {!ready ? (
            <div className="workspace-dock-empty">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="workspace-dock-empty">This agent has not written a readable turn yet.</div>
          ) : (
            entries.map((entry) => <HistoryEntryArticle key={entry.id} entry={entry} />)
          )}
        </div>
      </div>
    </div>
  )
}
