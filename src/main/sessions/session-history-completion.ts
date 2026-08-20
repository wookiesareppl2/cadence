type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null
}

// Claude writes one assistant row for each model/tool step. Only terminal stop
// reasons represent the response the user should see in History. Missing
// stop_reason is retained for older transcripts that predate the field.
export function isClaudeFinalAssistantMessage(message: unknown): boolean {
  const stopReason = asRecord(message)?.stop_reason
  if (stopReason === undefined) return true
  if (stopReason === null || stopReason === 'tool_use' || stopReason === 'pause_turn') return false
  return typeof stopReason === 'string'
}

// Current Codex rollouts distinguish narration from the completed answer with
// phase. Keep phase-less legacy messages readable, but never surface commentary.
export function isCodexFinalAssistantMessage(payload: unknown): boolean {
  const phase = asRecord(payload)?.phase
  return phase === undefined || phase === 'final_answer'
}
