import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@shared/platform'
import type { AgentActivityResult, AgentRun } from '@shared/agent-activity'
import { summariseAgentRuns } from '@shared/agent-activity'

// Two cadences. The fast one is for when the Agents pane is actually on screen; the
// slow one keeps the titlebar's running count honest while it is not, which is the
// whole point of having a badge you can see from anywhere. Agents write a transcript
// line every few seconds at most, and the main process answers an unchanged poll
// with a stat rather than a re-parse, so neither is expensive.
export const AGENT_POLL_VISIBLE_MS = 4_000
export const AGENT_POLL_BACKGROUND_MS = 15_000

export type AgentActivityState = {
  runs: AgentRun[]
  summary: AgentActivityResult['summary']
  // False only until the first scan resolves, so the panel can distinguish
  // "still looking" from "this session has spawned nothing".
  ready: boolean
  refresh: () => void
}

const EMPTY_SUMMARY = summariseAgentRuns([])

export function useAgentActivity(
  platform: PlatformId,
  sessionId: string | null,
  active: boolean,
  intervalMs: number = AGENT_POLL_VISIBLE_MS
): AgentActivityState {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [summary, setSummary] = useState<AgentActivityResult['summary']>(EMPTY_SUMMARY)
  const [ready, setReady] = useState(false)
  const [nonce, setNonce] = useState(0)

  // Guards against a slow scan for a previous session landing after the user has
  // moved on and repainting the panel with the wrong session's agents.
  const requestRef = useRef(0)

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    // Reset immediately on a session or platform change: showing the previous
    // session's agents while the new scan runs would be actively misleading.
    setRuns([])
    setSummary(EMPTY_SUMMARY)
    setReady(false)

    if (!active || sessionId === null) return undefined

    let cancelled = false
    const request = requestRef.current + 1
    requestRef.current = request

    const load = async (): Promise<void> => {
      try {
        const result = await window.dashboard.agents.activity(platform, sessionId)
        if (cancelled || requestRef.current !== request) return
        setRuns(result.runs)
        setSummary(result.summary)
      } catch {
        // A failed scan leaves the last good list in place rather than blanking the
        // panel; the next poll will correct it.
      } finally {
        if (!cancelled && requestRef.current === request) setReady(true)
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [platform, sessionId, active, intervalMs, nonce])

  return { runs, summary, ready, refresh }
}
