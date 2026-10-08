export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Meter = {
  /** Input tokens the last response was answered over, when one reported it. */
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd: number | null
  /** The last main-loop turn. */
  lastTurn: Tokens | null
  /** Every turn this session, subagents' included. */
  session: Tokens
  turns: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { meter: Meter; isHidden: boolean }
  }
}
