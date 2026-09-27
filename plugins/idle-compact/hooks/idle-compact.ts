import type { EngineInterface, Register, Timer } from 'claude-code'

// Compact the main conversation once after it has been idle for 40 minutes,
// while the 1h prompt cache is still warm.
export const IDLE_MS = 40 * 60 * 1000
// A timer that fires this late (for example after the machine slept) may find
// the cache already cold, so compacting would re-cache the whole context.
export const LATEST_MS = 55 * 60 * 1000

type Armed = {
  generation: number
  timer: Timer
  sessionId: string
  armedAt: number
}

type State = {
  generation: number
  armed: Armed | null
  currentTurnId: string | null
  isCompacting: boolean
}

async function debug($: EngineInterface, text: string) {
  try {
    await $.ui.log(`idle-compact: ${text}`, { to: 'debug' })
  } catch {}
}

async function notice($: EngineInterface, text: string) {
  try {
    await $.ui.log(`idle-compact: ${text}`, { to: 'transcript' })
  } catch {}
}

function cancel(state: State) {
  state.generation++
  state.armed?.timer.cancel()
  state.armed = null
}

async function arm($: EngineInterface, state: State) {
  cancel(state)
  const generation = state.generation
  const armedAt = await $.clock.now()
  const sessionId = await $.session.id()
  // A turn may have started while awaiting.
  if (state.generation !== generation) return
  const timer = $.clock.after(IDLE_MS, () => void fire($, state, generation))
  state.armed = { generation, timer, sessionId, armedAt }
  await debug($, `armed at ${new Date(armedAt).toISOString()}`)
}

async function fire($: EngineInterface, state: State, generation: number) {
  const armed = state.armed
  if (armed === null || armed.generation !== generation || state.isCompacting) return
  state.armed = null
  try {
    const elapsed = (await $.clock.now()) - armed.armedAt
    const minutes = (elapsed / 60000).toFixed(1)
    if (elapsed < IDLE_MS || elapsed >= LATEST_MS) {
      await debug($, `fired after ${minutes} min: outside the window, skipped`)
      return
    }
    if ((await $.session.id()) !== armed.sessionId) {
      await debug($, `fired after ${minutes} min: session changed, skipped`)
      return
    }
    if (state.generation !== generation) return
    state.isCompacting = true
    await $.session.compact()
    await notice($, `compacted after ${minutes} idle minutes`)
  } catch (error) {
    // Refused while a turn runs, with DISABLE_COMPACT, or in a headless host: not retried.
    await debug($, `compaction failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    state.isCompacting = false
  }
}

export const register: Register = (on) => {
  const state: State = { generation: 0, armed: null, currentTurnId: null, isCompacting: false }

  on('turn.start', ($, e, next) => {
    cancel(state)
    state.currentTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Only a main-loop turn the person sent, answered normally, arms the timer.
    if (e.agentId !== undefined || e.reason !== 'answer' || state.isCompacting) return result
    if (e.turnId !== state.currentTurnId) return result
    state.currentTurnId = null
    await arm($, state)
    return result
  })

  // A manual or automatic compaction leaves nothing for the pending timer to do.
  on('session.compact', ($, e, next) => {
    if (e.agentId === undefined && (e.trigger === 'manual' || e.trigger === 'auto')) cancel(state)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    cancel(state)
    state.currentTurnId = null
    return next(e)
  })
}
