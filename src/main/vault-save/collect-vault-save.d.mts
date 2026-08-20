// Types for the shared vault save collector's exported helpers.
//
// This declaration exists ONLY so tests can check the bootstrap skeleton and its
// archived legacy bank against the collector's real logic rather than against
// re-stated rules. The .mjs itself is untouched and must stay byte-identical to
// the ~/.claude and ~/.codex copies; adding a sibling declaration does not
// affect it.

// These shapes MUST match the collector's real returns. A declaration that lies
// about shape is the exact self-confirming failure this file exists to avoid — a
// test could then read a field that does not exist at runtime and still typecheck.
export declare function entriesIn(text: string): { id: string; heading: string; body: string }[]
export declare function countEntries(filePath: string, prefix: string): number
export declare function canonicalEntryLevel(text: string): number | null
export declare function normalizeEntryHeading(entryText: string, level: number): string
export declare function normalizedAdditions(...args: unknown[]): unknown
export declare function trueEntryCounts(...args: unknown[]): Record<string, number>
// Each string is e.g. "ADR-011 cited by ADR-042".
export declare function danglingReferences(memory: string): string[]
export declare const INDEX_COUNT_MAP: [string, string, RegExp][]
