import { useEffect, useState } from 'react'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/app-settings'

// The window's view of application settings.
//
// Settings used to be read only inside the Settings modal, which was fine while the
// only setting was a toggle nothing else consulted. Project roots are read by the
// Projects list too, so the value has to live outside the modal and stay current
// when it changes — otherwise the list keeps describing a configuration the user
// has already replaced.
export function useAppSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)

  useEffect(() => {
    let cancelled = false
    const api = window.dashboard?.settings
    if (!api) return

    api
      .get()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch(() => {
        // Keep the defaults. Defaults mean "no roots configured", which shows every
        // project — the failure that hides nothing.
      })

    const unsubscribe = api.onChanged?.((next) => setSettings(next))
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return settings
}
