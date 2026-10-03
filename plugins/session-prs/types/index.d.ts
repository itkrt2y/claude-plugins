export type CreatedPr = { url: string; repo: string; number: number }

export type SessionPrs = { prs: CreatedPr[]; isHidden: boolean }

// A PR in the index kept across sessions, with the session that created it.
export type IndexedPr = CreatedPr & {
  sessionId: string
  cwd: string
  branch: string | null
  recordedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-prs': { band: SessionPrs }
  }
}
