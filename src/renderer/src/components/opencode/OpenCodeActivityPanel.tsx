import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { FileRequest } from '@shared/project-files'
import {
  isOpenCodeSessionId,
  openCodeAgentAttachCommand,
  openCodeAgentTerminalId,
  type OpenCodeActivitySnapshot,
  type OpenCodeAgentActivity,
  type OpenCodeAgentPaneLayout
} from '@shared/opencode'
import { TerminalPane } from '@renderer/components/terminal-deck'
import './opencode-activity-panel.css'

const ACTIVITY_POLL_MS = 2_500
const PREFERENCE_KEY = 'opencode:agent-panes:v1'
type ActivityView = 'activity' | 'panes'

type ActivityPreferences = {
  view: ActivityView
  layout: OpenCodeAgentPaneLayout
}

const DEFAULT_PREFERENCES: ActivityPreferences = { view: 'activity', layout: 'tiled' }

function readPreferences(): ActivityPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? '{}') as Partial<ActivityPreferences>
    const view = parsed.view === 'panes' ? 'panes' : 'activity'
    const layout = parsed.layout === 'rows' || parsed.layout === 'columns' ? parsed.layout : 'tiled'
    return { view, layout }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function costLabel(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '--'
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
}

function modelLabel(model: string | null): string {
  return model?.replace(/^opencode-go\//, '') ?? 'Awaiting model'
}

function OpenPaneIcon(): JSX.Element {
  return (
    <svg className="opencode-activity-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6h12M8 6v7.5" />
    </svg>
  )
}

function paneMeta(job: OpenCodeAgentActivity): string {
  return `${job.title} · ${modelLabel(job.model)}`
}

export function OpenCodeActivityPanel({
  sessionId,
  projectPath,
  wslDistro,
  onOpenFile
}: {
  sessionId: string | null
  projectPath: string | null
  wslDistro: string | null
  onOpenFile?: (request: FileRequest, line?: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const [preferences, setPreferences] = useState<ActivityPreferences>(readPreferences)
  const [snapshot, setSnapshot] = useState<OpenCodeActivitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissedPaneIds, setDismissedPaneIds] = useState<Set<string>>(() => new Set())
  const [companionEnabled, setCompanionEnabled] = useState(false)
  const [companionReady, setCompanionReady] = useState(false)
  const { view, layout } = preferences

  const refresh = useCallback(async () => {
    if (!sessionId) return
    // The selection can still name a Claude or Codex session (a UUID) when this
    // panel mounts. There is no OpenCode activity to show for one, so drop the
    // stale snapshot rather than polling for it every few seconds.
    if (!isOpenCodeSessionId(sessionId)) {
      setSnapshot(null)
      setError(null)
      return
    }
    try {
      setSnapshot(await window.dashboard.openCode.getActivity(sessionId))
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Activity unavailable')
    }
  }, [sessionId])

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences))
    } catch {
      // The in-memory preference still works when storage is unavailable.
    }
  }, [preferences])

  useEffect(() => {
    setSnapshot(null)
    setError(null)
    setDismissedPaneIds(new Set())
    if (!sessionId) return
    void refresh()
    const id = window.setInterval(refresh, ACTIVITY_POLL_MS)
    return () => window.clearInterval(id)
  }, [refresh, sessionId])

  useEffect(() => {
    let cancelled = false
    window.dashboard.openCode
      .getCompanionState()
      .then((state) => {
        if (cancelled) return
        setCompanionEnabled(state.enabled)
        setCompanionReady(true)
      })
      .catch(() => {
        if (!cancelled) setCompanionReady(true)
      })
    const remove = window.dashboard.openCode.onCompanionStateChanged((state) => {
      setCompanionEnabled(state.enabled)
      setCompanionReady(true)
    })
    return () => {
      cancelled = true
      remove()
    }
  }, [])

  const paneJobs = useMemo(
    () => snapshot?.jobs.filter((job) => !dismissedPaneIds.has(job.sessionId)) ?? [],
    [dismissedPaneIds, snapshot]
  )
  const hiddenPaneCount = (snapshot?.jobs.length ?? 0) - paneJobs.length

  const summary = !sessionId
    ? 'Select a session'
    : error
      ? 'Unavailable'
      : snapshot
        ? `${snapshot.jobs.length} ${snapshot.jobs.length === 1 ? 'agent' : 'agents'} · ${snapshot.pendingTodos} pending`
        : 'Checking activity'

  const openOnlyPane = useCallback(
    (targetSessionId: string) => {
      const dismissed = new Set(
        snapshot?.jobs.filter((job) => job.sessionId !== targetSessionId).map((job) => job.sessionId) ?? []
      )
      setDismissedPaneIds(dismissed)
      setPreferences((current) => ({ ...current, view: 'panes' }))
      setOpen(true)
    },
    [snapshot]
  )

  const showAllPanes = useCallback(() => {
    setDismissedPaneIds(new Set())
    setPreferences((current) => ({ ...current, view: 'panes' }))
  }, [])

  const toggleCompanion = useCallback(() => {
    const next = !companionEnabled
    setCompanionEnabled(next)
    window.dashboard.openCode
      .setCompanionEnabled(next)
      .then((state) => setCompanionEnabled(state.enabled))
      .catch(() => setCompanionEnabled(!next))
  }, [companionEnabled])

  return (
    <section
      className={`panel opencode-activity ${open ? 'expanded' : 'collapsed'}`}
      data-view={view}
      aria-label="OpenCode agents"
    >
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
            <div className="opencode-activity-toolbar">
              <div className="opencode-activity-mode-toggle" aria-label="Agent activity view">
                {(['activity', 'panes'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={view === option ? 'active' : undefined}
                    aria-pressed={view === option}
                    onClick={() => setPreferences((current) => ({ ...current, view: option }))}
                  >
                    {option === 'activity' ? 'Activity' : 'Live panes'}
                  </button>
                ))}
              </div>
              {view === 'panes' ? (
                <>
                  <div className="opencode-activity-layout-toggle" aria-label="Agent pane layout">
                    {(['tiled', 'rows', 'columns'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={layout === option ? 'active' : undefined}
                        aria-pressed={layout === option}
                        onClick={() => setPreferences((current) => ({ ...current, layout: option }))}
                      >
                        {option[0].toUpperCase() + option.slice(1)}
                      </button>
                    ))}
                  </div>
                  {hiddenPaneCount > 0 ? (
                    <button type="button" className="opencode-activity-show-all" onClick={showAllPanes}>
                      Show all ({snapshot?.jobs.length ?? 0})
                    </button>
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                className="opencode-companion-toggle"
                role="switch"
                aria-checked={companionEnabled}
                disabled={!companionReady}
                onClick={toggleCompanion}
                title={companionEnabled ? 'Turn off Companion' : 'Turn on Companion'}
              >
                <span>Companion</span>
                <span className="opencode-companion-toggle-track" aria-hidden="true">
                  <span />
                </span>
              </button>
            </div>

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
            ) : view === 'activity' ? (
              <div className="opencode-activity-jobs">
                {snapshot.jobs.map((job) => (
                  <div className="opencode-activity-job" key={job.sessionId}>
                    <span className="opencode-activity-status" data-status={job.status} aria-label={job.status} />
                    <span className="opencode-activity-agent">{job.agent ?? 'subagent'}</span>
                    <span className="opencode-activity-job-title" title={job.title}>{job.title}</span>
                    <span className="opencode-activity-model" title={job.model ?? undefined}>{modelLabel(job.model)}</span>
                    <span className="opencode-activity-cost">{costLabel(job.cost)}</span>
                    <button
                      type="button"
                      className="opencode-activity-open-pane"
                      onClick={() => openOnlyPane(job.sessionId)}
                      aria-label={`Open ${job.agent ?? 'subagent'} in a live pane`}
                      title="Open this agent in a live pane"
                    >
                      <OpenPaneIcon />
                    </button>
                  </div>
                ))}
              </div>
            ) : !open ? null : !projectPath ? (
              <span className="opencode-activity-error">The project path is unavailable for live panes.</span>
            ) : paneJobs.length === 0 ? (
              <div className="opencode-activity-pane-empty">
                <span>All agent panes are closed.</span>
                <button type="button" className="terminal-action" onClick={showAllPanes}>Show all panes</button>
              </div>
            ) : (
              <div className="opencode-activity-pane-grid" data-layout={layout} data-count={paneJobs.length}>
                {paneJobs.map((job) => (
                  <TerminalPane
                    key={job.sessionId}
                    terminalId={openCodeAgentTerminalId(sessionId, job.sessionId)}
                    platform="opencode"
                    cwd={projectPath}
                    wslDistro={wslDistro}
                    initialInput={openCodeAgentAttachCommand(job.sessionId)}
                    title={`@${job.agent ?? 'subagent'}`}
                    headerMeta={paneMeta(job)}
                    statusLabel={job.status}
                    closeOnUnmount
                    closeTitle="Close this viewer; the agent keeps running"
                    onClose={() =>
                      setDismissedPaneIds((current) => new Set([...current, job.sessionId]))
                    }
                    onOpenFile={onOpenFile}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
