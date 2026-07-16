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

const OPEN_CODE_ACTIVITY_PARTS = new Set(['subtask', 'tool', 'patch', 'retry', 'compaction', 'agent'])

// OpenCode updates an assistant message's parts while a turn is running. Once
// the message is complete, keep only visible text written after its final task
// activity; tool names, patches, retries, and progress narration are not replies.
export function completedOpenCodeAssistantText(message: unknown, parts: unknown[]): string | null {
  const completedAt = asRecord(asRecord(message)?.time)?.completed
  if (typeof completedAt !== 'number') return null

  let lastActivityIndex = -1
  for (let index = 0; index < parts.length; index += 1) {
    const type = asRecord(parts[index])?.type
    if (typeof type === 'string' && OPEN_CODE_ACTIVITY_PARTS.has(type)) lastActivityIndex = index
  }

  const text = parts
    .slice(lastActivityIndex + 1)
    .map(asRecord)
    .filter((part): part is UnknownRecord => Boolean(part))
    .filter((part) => part.type === 'text' && part.synthetic !== true && part.ignored !== true)
    .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')

  return text || null
}

export function isOpenCodeSessionActive(status: unknown): boolean {
  const type = asRecord(status)?.type
  return type === 'busy' || type === 'retry'
}
