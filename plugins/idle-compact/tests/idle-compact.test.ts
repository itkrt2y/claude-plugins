import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MIN = 60 * 1000
const T0 = 1_700_000_000_000

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type World = { compacts: number; sessionId: string }

function world(on: On): World {
  const w: World = { compacts: 0, sessionId: 'session-a' }
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.compact', () => {
    w.compacts++
    return { messages: SUMMARY }
  })
  return w
}

let turns = 0
async function startTurn($: Engine) {
  const turnId = `turn-${++turns}`
  await $.turn.start({ text: 'hi', turnId })
  return turnId
}

async function completeTurn($: Engine, turnId: string) {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

async function mainTurn($: Engine) {
  await completeTurn($, await startTurn($))
}

describe('idle compact', () => {
  test('does not compact before 40 minutes', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(40 * MIN - 1000)
    expect(w.compacts).toBe(0)
  })

  test('compacts once at 40 minutes and does not re-arm', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(40 * MIN)
    expect(w.compacts).toBe(1)
    await clock.advance(5 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })

  test('a new turn cancels the timer and idle time counts from its completion', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(30 * MIN)
    const turnId = await startTurn($)
    await clock.advance(30 * MIN)
    expect(w.compacts).toBe(0)
    await completeTurn($, turnId)
    await clock.advance(40 * MIN - 1000)
    expect(w.compacts).toBe(0)
    await clock.advance(1000)
    expect(w.compacts).toBe(1)
  })

  test('a subagent turn.complete does not arm', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await $.turn.complete({
      answer: 'ok', durationMs: 1, isAborted: false, turnId: 'agent-turn', reason: 'answer', agentId: 'agent-1',
    })
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('a manual compaction cancels the timer', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    expect(w.compacts).toBe(1)
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })

  test('session end cancels the timer', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('a session switch while idle skips the compaction', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    w.sessionId = 'session-b'
    await clock.advance(40 * MIN)
    expect(w.compacts).toBe(0)
  })
})

// A timer that fires late against the wall clock (the machine slept through it):
// clock.after resolves only when the test says so, clock.now reads `now`.
function lateClock(on: On) {
  const c = { now: T0, fire: () => {}, onNow: () => {} }
  on('clock.now', () => {
    c.onNow()
    return { value: c.now }
  })
  on('clock.after', () => new Promise((resolve) => { c.fire = () => resolve({ value: undefined }) }))
  return c
}

async function fireAt($: Engine, c: ReturnType<typeof lateClock>, elapsed: number) {
  c.now = T0 + elapsed
  const seen = new Promise<void>((resolve) => { c.onNow = resolve })
  c.fire()
  await seen
  // Engine round trips through an ignored event (a subagent completion) let the callback finish.
  for (let i = 0; i < 5; i++) {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'sub' })
  }
}

describe('idle compact against the wall clock', () => {
  test('a callback running at 55 minutes does not compact', async ($, on) => {
    const c = lateClock(on)
    const w = world(on)
    await mainTurn($)
    await fireAt($, c, 55 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('a callback running at 45 minutes compacts', async ($, on) => {
    const c = lateClock(on)
    const w = world(on)
    await mainTurn($)
    await fireAt($, c, 45 * MIN)
    expect(w.compacts).toBe(1)
  })
})
