import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Meter, Tokens } from '../types'

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const EMPTY: Meter = {
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  rateLimits: [],
  costUsd: null,
  lastTurn: null,
  session: ZERO,
  turns: 0,
}

const meter = atom({ plugin: 'token-meter', key: 'meter' } as const, EMPTY)
const isHidden = atom({ plugin: 'token-meter', key: 'isHidden' } as const, false)

// 1234 -> "1.2k", 1234567 -> "1.2M"
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'k'
  return String(Math.round(n))
}

// Everything the model read for a turn: uncached + cache-read + cache-written
function totalIn(t: Tokens): number {
  return t.input + t.cacheRead + t.cacheWrite
}

function add(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5시간'
  if (kind === 'seven_day') return '7일'
  if (kind === 'spend_limit') return '한도'
  return kind
}

// The measured part of the meter: context fill, rate limits and cost
function measured(
  m: Meter,
  context: SessionContextUsage,
  rateLimits: readonly SessionRateLimit[],
  usd: number | undefined,
): Meter {
  return {
    ...m,
    contextTokens: context.tokens ?? m.contextTokens,
    contextWindow: context.window,
    contextPercent: context.percent ?? m.contextPercent,
    rateLimits: rateLimits.map(r =>
      r.resetsAt === undefined
        ? { kind: r.kind, percentUsed: r.percentUsed }
        : { kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt },
    ),
    costUsd: usd ?? m.costUsd,
  }
}

function contextColor(percent: number | null): string | undefined {
  if (percent === null) return undefined
  if (percent >= 85) return 'red'
  if (percent >= 60) return 'yellow'
  return undefined
}

function hasData(m: Meter): boolean {
  return m.contextWindow !== null || m.turns > 0
}

function tokenLine(label: string, t: Tokens): string {
  const cached = totalIn(t) > 0 ? Math.round((t.cacheRead / totalIn(t)) * 100) : 0
  return (
    `${label}: 입력 ${fmt(totalIn(t))} (신규 ${fmt(t.input)} · 캐시 읽기 ${fmt(t.cacheRead)} · ` +
    `캐시 쓰기 ${fmt(t.cacheWrite)}, 캐시 적중 ${cached}%) / 출력 ${fmt(t.output)}`
  )
}

function report(m: Meter): string {
  if (!hasData(m)) return '아직 측정된 사용량이 없습니다. 첫 턴이 끝나면 표시됩니다.'
  const lines: string[] = []
  if (m.contextWindow !== null) {
    const used = m.contextTokens === null ? '?' : fmt(m.contextTokens)
    const percent = m.contextPercent === null ? '' : ` (${m.contextPercent}%)`
    lines.push(`컨텍스트: ${used} / ${fmt(m.contextWindow)}${percent}`)
  }
  if (m.lastTurn !== null) lines.push(tokenLine('마지막 턴', m.lastTurn))
  lines.push(tokenLine(`세션 합계 (${m.turns}턴, 서브에이전트 포함)`, m.session))
  for (const r of m.rateLimits) {
    const resets = r.resetsAt === undefined ? '' : `, 초기화 ${r.resetsAt}`
    lines.push(`사용 한도 ${limitLabel(r.kind)}: ${r.percentUsed}%${resets}`)
  }
  if (m.costUsd !== null) lines.push(`비용: $${m.costUsd.toFixed(2)}`)
  return lines.join('\n')
}

// Read the figures the engine already has, so the band is filled after a reload
async function seed($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  await update($, meter, m => measured(m, usage.context, usage.rateLimits, usage.cost?.usd))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: '토큰 사용량 상세 보기 (hide · show · reset)',
      argumentHint: '[hide|show|reset]',
      immediate: true,
    })
    await seed($)

    return next(e)
  })

  // Context fill, rate limits and cost, pushed by the engine after each turn
  on('session.measure', async ($, e, next) => {
    await update($, meter, m => measured(m, e.context, e.rateLimits, e.cost?.usd))

    return next(e)
  })

  // What each turn spent; a subagent's turn counts toward the session only
  on('turn.complete', async ($, e, next) => {
    const usage = e.usage
    if (usage !== undefined) {
      const spent: Tokens = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      }
      const isMain = e.agentId === undefined
      await update($, meter, m => ({
        ...m,
        lastTurn: isMain ? spent : m.lastTurn,
        session: add(m.session, spent),
        turns: m.turns + (isMain ? 1 : 0),
      }))
    }

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide') {
      await update($, isHidden, () => true)
      return { text: '토큰 표시줄을 숨겼습니다. /tokens show 로 다시 켭니다.' }
    }
    if (arg === 'show') {
      await update($, isHidden, () => false)
      return { text: '토큰 표시줄을 켰습니다.' }
    }
    if (arg === 'reset') {
      await update($, meter, m => ({ ...m, lastTurn: null, session: ZERO, turns: 0 }))
      return { text: '세션 토큰 합계를 0으로 되돌렸습니다.' }
    }

    return { text: report(await read($, meter)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, meter)
    if (e.props.hasSurvey || !hasData(m) || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const sep = '  ·  '
    const parts: string[] = []
    if (m.lastTurn !== null) {
      parts.push(`턴 ↑${fmt(totalIn(m.lastTurn))} ↓${fmt(m.lastTurn.output)}`)
    }
    if (m.turns > 0) {
      parts.push(`세션 ↑${fmt(totalIn(m.session))} ↓${fmt(m.session.output)}`)
    }
    for (const r of m.rateLimits) {
      parts.push(`${limitLabel(r.kind)} ${Math.round(r.percentUsed)}%`)
    }
    if (m.costUsd !== null) parts.push(`$${m.costUsd.toFixed(2)}`)

    const context =
      m.contextWindow === null
        ? null
        : `컨텍스트 ${m.contextPercent === null ? '–' : m.contextPercent + '%'} ` +
          `(${m.contextTokens === null ? '?' : fmt(m.contextTokens)}/${fmt(m.contextWindow)})`
    const color = contextColor(m.contextPercent)

    return (
      <Box flexDirection="row" columnGap={2}>
        {context === null ? null : color === undefined ? (
          <Text dimColor>{context}</Text>
        ) : (
          <Text color={color} bold>{context}</Text>
        )}
        <Text dimColor wrap="truncate-end">{parts.join(sep)}</Text>
        <Button key="hide" label="숨기기" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
