import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { claudeSessions } from '@platforms/claude/fixtures'
import { codexSessions, codexUsageState } from '@platforms/codex/fixtures'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import type { ClaudeUsageSummary, TokenUsage } from '@shared/usage'
import { emptyTokenUsage } from '@shared/usage'

const formatNumber = (value: number): string => new Intl.NumberFormat('en-US').format(value)

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

function ClaudeWorkspace(): JSX.Element {
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
      .then((summary) => {
        if (!cancelled) setUsageSummary(summary)
      })
      .catch((error: unknown) => {
        if (!cancelled) setUsageError(error instanceof Error ? error.message : 'Usage scan failed')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const rollingUsage = usageSummary?.rolling.usage ?? emptyTokenUsage()
  const weeklyUsage = usageSummary?.weekly.usage ?? emptyTokenUsage()
  const requestCount = usageSummary?.rolling.requestCount ?? 0
  const statusLabel = usageError ? 'scan error' : usageSummary ? 'live sqlite' : 'scanning'

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
          <UsageBlock label="In" value={rollingUsage.inputTokens} />
          <UsageBlock label="Out" value={rollingUsage.outputTokens} />
          <UsageBlock label="Cache" value={rollingUsage.cacheCreationInputTokens + rollingUsage.cacheReadInputTokens} />
          <UsageBlock label="Total" value={rollingUsage.totalTokens} strong />
          <div className="usage-window">
            <span>Req</span>
            <strong>{formatNumber(requestCount)}</strong>
          </div>
          <div className="usage-window">
            <span>{usageSummary?.weekly.label ?? '7d'}</span>
            <strong>{formatCompactTokens(weeklyUsage.totalTokens)}</strong>
          </div>
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
              <dt>primary</dt>
              <dd>{formatUsageDigest(rollingUsage)}</dd>
            </div>
            <div>
              <dt>secondary</dt>
              <dd>{formatUsageDigest(weeklyUsage)}</dd>
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

function UsageBlock({ label, value, strong = false }: { label: string; value: number; strong?: boolean }): JSX.Element {
  return (
    <div className={`usage-block ${strong ? 'strong' : ''}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  )
}

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return formatNumber(value)
}

function formatUsageDigest(usage: TokenUsage): string {
  return `${formatCompactTokens(usage.totalTokens)} total`
}
