import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { claudeSessions, claudeUsageSummary } from '@platforms/claude/fixtures'
import { codexSessions, codexUsageState } from '@platforms/codex/fixtures'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'

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
          <UsageBlock label="In" value={claudeUsageSummary.rolling.inputTokens} />
          <UsageBlock label="Out" value={claudeUsageSummary.rolling.outputTokens} />
          <UsageBlock label="Total" value={claudeUsageSummary.rolling.totalTokens} strong />
          <UsageBlock label="Req" value={claudeUsageSummary.requestCount} />
          <div className="usage-window">
            <span>{claudeUsageSummary.rolling.label}</span>
            <strong>{claudeUsageSummary.rolling.percentUsed}% est.</strong>
          </div>
          <div className="usage-window">
            <span>{claudeUsageSummary.weekly.label}</span>
            <strong>{claudeUsageSummary.weekly.percentUsed}% est.</strong>
          </div>
        </div>

        <section className="panel terminal-panel">
          <div className="panel-header">
            <h1>Claude Code</h1>
            <span className="status-pill">PTY pending</span>
          </div>
          <div className="terminal-surface" aria-label="Terminal preview">
            <p>$ claude</p>
            <p>usage source: ~/.claude/projects/*/*.jsonl</p>
            <p>dedupe: requestId</p>
            <p>sqlite aggregation: pending</p>
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
              <dd>{claudeUsageSummary.dedupeKey}</dd>
            </div>
            <div>
              <dt>primary</dt>
              <dd>5h rolling window</dd>
            </div>
            <div>
              <dt>secondary</dt>
              <dd>weekly aggregate</dd>
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
