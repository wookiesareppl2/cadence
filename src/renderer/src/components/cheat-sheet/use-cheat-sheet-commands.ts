import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_COMMANDS, type CheatCommand, type CommandShell } from './terminal-commands'

// The cheat sheet is user-owned content: it seeds from the built-in defaults on
// first run, then every add/edit/delete is persisted locally. Bump the version
// suffix if the stored shape ever changes incompatibly.
const STORAGE_KEY = 'cheat-sheet:commands:v1'

export type CheatCommandDraft = Omit<CheatCommand, 'id'>

export type CheatSheetCommandsState = {
  commands: CheatCommand[]
  addCommand: (draft: CheatCommandDraft) => void
  updateCommand: (id: string, draft: CheatCommandDraft) => void
  removeCommand: (id: string) => void
  resetDefaults: () => void
}

function isCheatCommand(value: unknown): value is CheatCommand {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    (entry.shell === 'powershell' || entry.shell === 'wsl') &&
    typeof entry.name === 'string' &&
    typeof entry.description === 'string' &&
    Array.isArray(entry.examples)
  )
}

function loadCommands(): CheatCommand[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isCheatCommand)) {
        return parsed.map((entry) => ({
          id: entry.id,
          shell: entry.shell as CommandShell,
          name: entry.name,
          fullName: typeof entry.fullName === 'string' ? entry.fullName : undefined,
          description: entry.description,
          examples: entry.examples.filter((example): example is string => typeof example === 'string')
        }))
      }
    }
  } catch {
    // Corrupt/unavailable storage falls back to the built-in defaults.
  }
  return DEFAULT_COMMANDS
}

function makeId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function useCheatSheetCommands(): CheatSheetCommandsState {
  const [commands, setCommands] = useState<CheatCommand[]>(() => loadCommands())

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(commands))
    } catch {
      // Persistence is best-effort; ignore quota/availability failures.
    }
  }, [commands])

  const addCommand = useCallback((draft: CheatCommandDraft) => {
    setCommands((prev) => [{ ...draft, id: makeId() }, ...prev])
  }, [])

  const updateCommand = useCallback((id: string, draft: CheatCommandDraft) => {
    setCommands((prev) => prev.map((entry) => (entry.id === id ? { ...draft, id } : entry)))
  }, [])

  const removeCommand = useCallback((id: string) => {
    setCommands((prev) => prev.filter((entry) => entry.id !== id))
  }, [])

  const resetDefaults = useCallback(() => {
    setCommands(DEFAULT_COMMANDS)
  }, [])

  return { commands, addCommand, updateCommand, removeCommand, resetDefaults }
}
