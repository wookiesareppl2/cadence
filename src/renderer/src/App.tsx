import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { ClaudePlanUsage } from '@shared/claude-plan-usage'
import { claudeSessions } from '@platforms/claude/fixtures'
import { codexSessions, codexUsageState } from '@platforms/codex/fixtures'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import type { ClaudeUsageSummary } from '@shared/usage'

const formatNumber = (value: number): string => new Intl.NumberFormat('en-US').format(value)

const PLAN_POLL_INTERVAL_MS = 180_000

export function App(): JSX.Element {
  const [platform, setPlatform] = useState<PlatformId>('claude')
  const activePlatform = PLATFORM_CONFIG[platform]

  const cssVars = useMemo(
    () =>
      ({
        '--accent': activePlatform.accent,
        '--accent-dim': activePlatform.accentDim,
        '--accent-hover': activePlatform.accentHover
      }) as React.CSSProperties,
    [activePlatform]
  )

  return (
    <div className="app-shell" style={cssVars} data-platform={platform}>
      <Titlebar platform={platform} onPlatformChange={setPlatform} />
      {platform === 'claude' ? <ClaudeWorkspace /> : <CodexWorkspace />}
    </div>
  )
}

function Titlebar({
  platform,
  onPlatformChange
}: {
  platform: PlatformId
  onPlatformChange: (platform: PlatformId) => void
}): JSX.Element {
  return (
    <header className="titlebar">
      <div className="platform-switcher" role="tablist" aria-label="Platform">
        {Object.values(PLATFORM_CONFIG).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={platform === item.id}
            className={platform === item.id ? 'active' : 'inactive'}
            onClick={() => onPlatformChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => window.dashboard.window.minimize()}>
          -
        </button>
        <button type="button" aria-label="Maximize" onClick={() => window.dashboard.window.toggleMaximize()}>
          □
        </button>
        <button type="button" aria-label="Close" className="close" onClick={() => window.dashboard.window.close()}>
          x
        </button>
      </div>
    </header>
  )
}

function useClaudePlanUsage(): { planUsage: ClaudePlanUsage | null; planError: string | null } {
  const [planUsage, setPlanUsage] = useState<ClaudePlanUsage | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const fetchPlan = useCallback(() => {
    if (!window.dashboard?.usage?.getClaudePlanUsage) return
    window.dashboard.usage
      .getClaudePlanUsage()
      .then(setPlanUsage)
      .catch((err: unknown) => setPlanError(err instanceof Error ? err.message : 'Failed to fetch plan usage'))
  }, [])

  useEffect(() => {
    fetchPlan()
    const id = setInterval(fetchPlan, PLAN_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchPlan])

  return { planUsage, planError }
}

function useCountdown(resetsAt: string | null): string {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!resetsAt) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [resetsAt])

  if (!resetsAt) return '--'

  const diffMs = new Date(resetsAt).getTime() - now
  if (diffMs <= 0) return 'Resetting...'

  const totalMin = Math.floor(diffMs / 60_000)
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60

  if (hours > 0) return `Resets in ${hours} hr ${mins} min`
  return `Resets in ${mins} min`
}

function barTier(pct: number): string {
  if (pct >= 80) return 'critical'
  if (pct >= 60) return 'warning'
  return 'normal'
}

function ClaudeWorkspace(): JSX.Element {
  const { planUsage, planError } = useClaudePlanUsage()
  const [usageSummary, setUsageSummary] = useState<ClaudeUsageSummary | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.dashboard?.usage) {
      setUsageError('Preload API unavailable: window.dashboard.usage was not exposed')
      return
    }
    let cancelled = false
    window.dashboard.usage
      .getClaudeSummary()
      .then((summary) => { if (!cancelled) setUsageSummary(summary) })
      .catch((err: unknown) => { if (!cancelled) setUsageError(err instanceof Error ? err.message : 'Usage scan failed') })
    return () => { cancelled = true }
  }, [])

  const statusLabel = (planError || usageError)
    ? 'error'
    : planUsage
      ? 'live'
      : 'connecting'

  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="Claude sessions">
        <div className="sidebar-header">
          <h2>Sessions</h2>
          <button type="button" className="icon-button" aria-label="New session">
            +
          </button>
        </div>
        <input className="sidebar-search" placeholder="Search sessions" aria-label="Search sessions" />
        <div className="session-list">
          {claudeSessions.map((session, index) => (
            <button key={session.id} type="button" className={`session-item ${index === 0 ? 'active' : ''}`}>
              <span className="session-title">{session.title}</span>
              <span className="session-project">{session.project}</span>
              <span className="session-meta">
                <span>{session.branch}</span>
                <span>{session.tokens}</span>
                <span>{session.age}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="content-grid" aria-label="Claude Code dashboard">
        <div className="usage-strip">
          {planError ? (
            <div className="usage-error">{planError}</div>
          ) : !planUsage ? (
            <div className="usage-loading">Fetching usage data...</div>
          ) : (
            <>
              {planUsage.fiveHour && (
                <UsageBar
                  label="5-Hour Usage"
                  utilization={planUsage.fiveHour.utilization}
                  resetsAt={planUsage.fiveHour.resetsAt}
                />
              )}
              {planUsage.sevenDay && (
                <UsageBar
                  label="Weekly Usage"
                  utilization={planUsage.sevenDay.utilization}
                  resetsAt={planUsage.sevenDay.resetsAt}
                />
              )}
            </>
          )}
        </div>

        <section className="panel terminal-panel">
          <div className="panel-header">
            <h1>Claude Code</h1>
            <span className="status-pill">{statusLabel}</span>
          </div>
          <div className="terminal-surface" aria-label="Terminal preview">
            <p>$ claude</p>
            <p>usage source: ~/.claude/projects/*/*.jsonl</p>
            <p>dedupe: requestId</p>
            <p>sqlite aggregation: {usageSummary ? usageSummary.databasePath : 'loading'}</p>
            {usageSummary ? (
              <>
                <p>files scanned: {formatNumber(usageSummary.ingest.scannedFileCount)}</p>
                <p>usage rows: {formatNumber(usageSummary.ingest.usageRowCount)}</p>
                <p>duplicates dropped: {formatNumber(usageSummary.ingest.duplicateUsageRowCount)}</p>
              </>
            ) : null}
            {usageError ? <p>error: {usageError}</p> : null}
          </div>
        </section>

        <section className="panel inspector-panel">
          <div className="panel-header">
            <h2>Parser Contract</h2>
            <span className="status-pill">critical</span>
          </div>
          <dl className="fact-list">
            <div>
              <dt>source</dt>
              <dd>~/.claude/projects/*/*.jsonl</dd>
            </div>
            <div>
              <dt>dedupe</dt>
              <dd>{usageSummary?.dedupeKey ?? 'requestId'}</dd>
            </div>
            <div>
              <dt>unique req</dt>
              <dd>{formatNumber(usageSummary?.ingest.uniqueRequestCount ?? 0)}</dd>
            </div>
            <div>
              <dt>skipped</dt>
              <dd>{formatNumber(usageSummary?.ingest.skippedUsageRows ?? 0)}</dd>
            </div>
          </dl>
        </section>
      </section>
    </main>
  )
}

function CodexWorkspace(): JSX.Element {
  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="Codex sessions">
        <div className="sidebar-header">
          <h2>Codex</h2>
        </div>
        <div className="session-action-group">
          <button type="button" className="primary-action">
            New Codex Session
          </button>
          <button type="button" className="secondary-action">
            Attach Workspace
          </button>
        </div>
        <div className="session-list">
          {codexSessions.map((session, index) => (
            <button key={session.id} type="button" className={`session-item ${index === 0 ? 'active' : ''}`}>
              <span className="session-title">{session.title}</span>
              <span className="session-project">{session.project}</span>
              <span className="session-meta">
                <span>{session.status}</span>
                <span>{session.age}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="content-grid" aria-label="Codex dashboard">
        <section className="panel codex-usage">
          <div className="panel-header">
            <h1>{codexUsageState.headline}</h1>
            <span className="status-pill">not configured</span>
          </div>
          <p className="muted-copy">{codexUsageState.detail}</p>
          <dl className="fact-list">
            {codexUsageState.telemetry.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="panel terminal-panel">
          <div className="panel-header">
            <h2>Codex Terminal</h2>
            <span className="status-pill">PTY pending</span>
          </div>
          <div className="terminal-surface" aria-label="Terminal preview">
            <p>$ codex</p>
            <p>usage source: OpenAI API</p>
            <p>local token cache: unavailable</p>
            <p>view state: isolated from Claude Code</p>
          </div>
        </section>
      </section>
    </main>
  )
}

function UsageBar({
  label,
  utilization,
  resetsAt,
  subtitle
}: {
  label: string
  utilization: number
  resetsAt: string | null
  subtitle?: string
}): JSX.Element {
  const countdown = useCountdown(resetsAt)
  const pct = Math.min(100, Math.max(0, Math.round(utilization)))
  const tier = barTier(pct)

  return (
    <div className="usage-bar-card" data-tier={tier}>
      <div className="usage-bar-header">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{pct}%</span>
      </div>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="usage-bar-footer">
        <span className="usage-bar-reset">{subtitle ?? countdown}</span>
      </div>
    </div>
  )
}
