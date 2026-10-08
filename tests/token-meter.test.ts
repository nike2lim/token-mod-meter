import { expect, test } from 'claude-code/testing'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

for (const surface of SURFACES) {
  test(`band shows context, turn and session tokens on ${surface}`, async ($, on) => {
    // Stand in for the engine beneath the mod
    on('session.measure', ($, e) => ({ changed: [...e.changed] }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', ($, e) => $.ui.resolve(e).Box({}))

    await $.session.measure({
      context: { tokens: 84_200, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
      cost: { usd: 0.42 },
      changed: ['context', 'rateLimits', 'cost'],
    })
    await $.turn.complete({
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 200,
        output_tokens: 850,
        cache_read_input_tokens: 80_000,
        cache_creation_input_tokens: 4_000,
      },
    })
    // A subagent's turn adds to the session, not to the last turn
    await $.turn.complete({
      answer: 'sub',
      durationMs: 500,
      isAborted: false,
      turnId: 't2',
      agentId: 'a1',
      reason: 'answer',
      usage: {
        model: 'claude-haiku-4-5',
        input_tokens: 1_000,
        output_tokens: 150,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })

    const ui = await $.ui.mount({ plugin: 'token-meter', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ type: 'Text', text: /컨텍스트/ }))?.text).toBe('컨텍스트 42% (84.2k/200k)')
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(all).toContain('턴 ↑84.2k ↓850')
    expect(all).toContain('세션 ↑85.2k ↓1.0k')
    expect(all).toContain('5시간 24%')
    expect(all).toContain('$0.42')

    const detail = await $.command.run({
      command: 'tokens',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
    expect(detail.text).toContain('컨텍스트: 84.2k / 200k (42%)')
    expect(detail.text).toContain('세션 합계 (1턴, 서브에이전트 포함)')

    // Hiding leaves the band to whatever is beneath
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: /컨텍스트/ })).toBe(undefined)
    await ui.unmount()
  })
}
