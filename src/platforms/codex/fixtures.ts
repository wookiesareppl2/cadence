export const codexSessions = [
  { id: 'x-201', title: 'Codex workspace shell', project: '~/projects/ai-dashboard', status: 'ready', age: 'idle' },
  { id: 'x-202', title: 'API usage adapter', project: 'OpenAI API', status: 'key required', age: 'blocked' },
  { id: 'x-203', title: 'Review queue', project: '~/projects/ai-dashboard', status: 'empty', age: 'idle' }
]

export const codexUsageState = {
  headline: 'API key required',
  detail: 'Codex usage has no local JSONL source. Usage appears here after an OpenAI API key is configured.',
  telemetry: [
    ['source', 'OpenAI API'],
    ['local cache', 'none'],
    ['status', 'not configured']
  ]
}
