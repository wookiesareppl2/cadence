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

  // Guards against a slow scan for a previous session landing after the user has
  // moved on and repainting the panel with the wrong session's agents.
  const requestRef = useRef(0)
  // A scan can outlast its own interval on a large history. Without this, ticks pile
  // up behind a slow scan and the main process ends up serving several at once.
  const inFlightRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (!active || sessionId === null || inFlightRef.current) return
    inFlightRef.current = true
    const request = requestRef.current

    try {
      const result = await window.dashboard.agents.activity(platform, sessionId)
      if (requestRef.current !== request) return
      setRuns(result.runs)
      setSummary(result.summary)
    } catch {
      // A failed scan leaves the last good list in place rather than blanking the
      // panel; the next poll will correct it.
    } finally {
      inFlightRef.current = false
      if (requestRef.current === request) setReady(true)
    }
  }, [platform, sessionId, active])

  // Identity: clear only when the thing being watched actually changes. This must NOT
  // depend on the cadence — the interval flips every time the dock opens or the pane
  // switches, and resetting there blanked the titlebar count and flashed "Loading…"
  // in the pane on a change that watches the very same session.
  useEffect(() => {
    requestRef.current += 1
    setRuns([])
    setSummary(EMPTY_SUMMARY)
    setReady(false)
  }, [platform, sessionId, active])

  // Schedule: re-armed when the cadence changes, without disturbing what is on screen.
  useEffect(() => {
    if (!active || sessionId === null) return undefined
    void load()
    const timer = window.setInterval(() => void load(), intervalMs)
    return () => window.clearInterval(timer)
  }, [load, intervalMs, active, sessionId])

  return { runs, summary, ready }
}
