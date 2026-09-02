import { useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import type { AppSettings } from '@shared/app-settings'
import type { ProjectRoot } from '@shared/project-roots'
import './settings.css'

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSettings(null)
    setError(null)
    window.dashboard.settings
      .get()
      .then((value) => {
        if (!cancelled) setSettings(value)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load settings.')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.requestAnimationFrame(() => dialogRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [onClose, open])

  if (!open) return null

  const updateMergeReview = async (): Promise<void> => {
    if (!settings || saving) return
    setSaving(true)
    setError(null)
    try {
      setSettings(
        await window.dashboard.settings.update({ mergeReviewEnabled: !settings.mergeReviewEnabled })
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the setting.')
    } finally {
      setSaving(false)
    }
  }

  const saveProjectRoots = async (projectRoots: ProjectRoot[]): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      setSettings(await window.dashboard.settings.update({ projectRoots }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your project folders.')
    } finally {
      setSaving(false)
    }
  }

  const addProjectRoot = async (): Promise<void> => {
    if (!settings || saving) return
    let picked: ProjectRoot | null = null
    try {
      picked = (await window.dashboard.projects?.pickRoot?.()) ?? null
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the folder picker.')
      return
    }
    if (!picked) return
    // Adding a folder already listed is a no-op rather than a duplicate row; the
    // stored list is keyed by the same id the matcher uses.
    if (settings.projectRoots.some((root) => root.id === picked.id)) return
    await saveProjectRoots([...settings.projectRoots, picked])
  }

  const removeProjectRoot = async (id: string): Promise<void> => {
    if (!settings || saving) return
    await saveProjectRoots(settings.projectRoots.filter((root) => root.id !== id))
  }

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <div className="settings-modal-backdrop" onMouseDown={handleBackdropClick}>
      <section
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <header className="settings-modal-header">
          <div>
            <p className="settings-modal-eyebrow">Cadence</p>
            <h1 id="settings-title">Settings</h1>
          </div>
          <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>
        <div className="settings-modal-body">
          <nav className="settings-categories" aria-label="Settings categories">
            <button type="button" className="settings-category active" aria-current="page">
              General
            </button>
          </nav>
          <div className="settings-content">
            <div className="settings-section-heading">
              <h2>General</h2>
              <p>Preferences that apply across projects and AI tools opened through Cadence.</p>
            </div>
            <section className="settings-group" aria-labelledby="git-workflow-settings">
              <div className="settings-group-heading">
                <h3 id="git-workflow-settings">Git workflow</h3>
                <span>Global</span>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <label htmlFor="merge-review-setting">Review merges with an independent agent</label>
                  <p>
                    Before an authorized merge, require one read-only AI reviewer to inspect the exact commit and
                    return a pass verdict. Commits and feature-branch pushes are unaffected.
                  </p>
                  <p className="settings-row-note">Applies to new or restarted terminal sessions.</p>
                </div>
                <button
                  id="merge-review-setting"
                  type="button"
                  role="switch"
                  aria-checked={settings?.mergeReviewEnabled ?? false}
                  aria-label="Review merges with an independent agent"
                  className={`settings-switch ${settings?.mergeReviewEnabled ? 'enabled' : ''}`}
                  disabled={!settings || saving}
                  onClick={() => void updateMergeReview()}
                >
                  <span className="settings-switch-thumb" />
                </button>
              </div>
            </section>
            <section className="settings-group" aria-labelledby="project-folder-settings">
              <div className="settings-group-heading">
                <h3 id="project-folder-settings">Project folders</h3>
                <span>Global</span>
              </div>
              <div className="settings-row settings-row-stacked">
                <div className="settings-row-copy">
                  <label id="project-folder-label">Where your projects live</label>
                  <p>
                    Cadence otherwise treats every folder an AI tool has ever run in as a project.
                    Name the folders your projects sit inside and only those are listed. A session
                    started deeper inside one is filed under its project rather than becoming a
                    separate entry.
                  </p>
                  <p className="settings-row-note">
                    {settings && settings.projectRoots.length === 0
                      ? 'None yet — every discovered folder is currently shown.'
                      : 'Folders you attach by hand are always listed, even from outside these.'}
                  </p>
                </div>
              </div>

              {settings && settings.projectRoots.length > 0 ? (
                <ul className="settings-root-list" aria-labelledby="project-folder-label">
                  {settings.projectRoots.map((root) => (
                    <li key={root.id} className="settings-root-row">
                      <span className="settings-root-origin">{root.distro ?? 'Windows'}</span>
                      <span className="settings-root-path" title={root.path}>
                        {root.path}
                      </span>
                      <button
                        type="button"
                        className="settings-root-remove"
                        onClick={() => void removeProjectRoot(root.id)}
                        disabled={saving}
                        aria-label={`Stop using ${root.path} as a project folder`}
                        title={`Stop using ${root.path} as a project folder`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <button
                type="button"
                className="settings-root-add"
                onClick={() => void addProjectRoot()}
                disabled={!settings || saving}
              >
                + Add folder
              </button>
              <p className="settings-root-hint">
                For WSL, open <strong>Linux</strong> in the picker’s sidebar and choose a folder
                inside your distro.
              </p>
            </section>
            {error ? <p className="settings-error" role="alert">{error}</p> : null}
          </div>
        </div>
      </section>
    </div>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  )
}
