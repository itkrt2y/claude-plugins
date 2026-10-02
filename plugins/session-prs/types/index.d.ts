export type CreatedPr = { url: string; repo: string; number: number }

export type SessionPrs = { prs: CreatedPr[]; isHidden: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-prs': { band: SessionPrs }
  }
}
