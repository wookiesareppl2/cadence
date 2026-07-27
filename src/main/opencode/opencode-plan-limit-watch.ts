import { getOpenCodeClient } from './opencode-runtime'
import { parsePlanLimit, recordPlanLimit, type PlanLimitErrorInput } from './opencode-plan-limit'

// The quota rejection reaches Cadence only as an event. Prompts are sent by the
// `opencode` TUI inside the terminal, not by Cadence's own client, so watching
// our own API calls would never see a 429. The server's event stream is
// instance-wide, so a rejection raised in any terminal session surfaces here.

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

let running = false
let stopped = false

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function watch(): Promise<void> {
  let backoff = RETRY_MIN_MS
  while (!stopped) {
    try {
      // Resolved each pass: a health restart moves the server to a new port, and
      // the stale client would otherwise reconnect to a dead one forever.
      const client = await getOpenCodeClient()
      const events = await client.event.subscribe()
      backoff = RETRY_MIN_MS
      for await (const event of events.stream) {
        if (stopped) return
        if (!event || typeof event !== 'object') continue
        const message = event as { type?: string; properties?: { error?: unknown } }
        if (message.type !== 'session.error') continue
        recordPlanLimit(parsePlanLimit(message.properties?.error as PlanLimitErrorInput))
      }
    } catch {
      // A dropped stream is expected across server restarts; back off and retry.
    }
    if (stopped) return
    await delay(backoff)
    backoff = Math.min(backoff * 2, RETRY_MAX_MS)
  }
}

/**
 * Idempotent. Called from the usage service, which already ensures the runtime —
 * so watching never becomes a new reason to start the OpenCode server.
 */
export function ensureOpenCodePlanLimitWatch(): void {
  if (running) return
  running = true
  stopped = false
  void watch()
}

export function stopOpenCodePlanLimitWatch(): void {
  stopped = true
  running = false
}
