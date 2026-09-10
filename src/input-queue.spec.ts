import { describe, expect, it } from 'vitest'
import { InputQueue } from './input-queue.ts'

describe('InputQueue', () => {
  it('hands a line straight back when nothing is running (idle push)', () => {
    const q = new InputQueue()
    expect(q.push('hello', false)).toEqual({ startNow: 'hello' })
    expect(q.size).toBe(0)
  })

  it('holds a line while a turn runs (busy push)', () => {
    const q = new InputQueue()
    expect(q.push('later', true)).toEqual({ startNow: undefined })
    expect(q.list()).toEqual(['later'])
  })

  it('releases exactly ONE line per settled turn, oldest first', () => {
    const q = new InputQueue()
    q.push('first', true)
    q.push('second', true)
    q.push('third', true)
    expect(q.list()).toEqual(['first', 'second', 'third'])

    // Turn 1 settles -> only the head is released.
    expect(q.releaseNext()).toBe('first')
    expect(q.list()).toEqual(['second', 'third'])
    // Turn 2 settles.
    expect(q.releaseNext()).toBe('second')
    // Turn 3 settles.
    expect(q.releaseNext()).toBe('third')
    // Queue drained: further settles release nothing.
    expect(q.releaseNext()).toBeUndefined()
    expect(q.size).toBe(0)
  })

  it('preserves order across a mix of busy and idle pushes', () => {
    const q = new InputQueue()
    expect(q.push('a', true)).toEqual({ startNow: undefined })
    expect(q.push('b', true)).toEqual({ startNow: undefined })
    // An idle push drains the OLDEST item, not the one just typed.
    expect(q.push('c', false)).toEqual({ startNow: 'a' })
    expect(q.list()).toEqual(['b', 'c'])
  })

  it('list() returns a copy so callers cannot mutate internal state', () => {
    const q = new InputQueue()
    q.push('x', true)
    const snapshot = q.list()
    snapshot.push('injected')
    expect(q.list()).toEqual(['x'])
  })
})

/**
 * Mirrors the drain loop in index.ts's `startTurn().finally()`: a settled turn
 * releases exactly one line and starts it as its OWN turn. These tests pin the
 * user-visible consequence — N queued lines produce N separate turns, not one
 * merged turn — and that a long queue does not blow the call stack.
 */
describe('drain loop: N queued lines produce N separate turns', () => {
  /** Replicates the production drain wiring over a fake async runTurn. */
  function harness(settle: () => Promise<void>) {
    const queue = new InputQueue()
    const started: string[] = []
    let turnRunning = false
    const isBusy = (): boolean => turnRunning

    const startTurn = (text: string): void => {
      turnRunning = true
      started.push(text)
      void settle().finally(() => {
        turnRunning = false
        const next = queue.releaseNext()
        if (next !== undefined) startTurn(next)
      })
    }

    const queueInput = (text: string): void => {
      const { startNow } = queue.push(text, isBusy())
      if (startNow !== undefined) startTurn(startNow)
    }

    return { queue, started, queueInput, startTurn, setBusy: (v: boolean) => { turnRunning = v } }
  }

  it('runs each queued line as its own turn, in order', async () => {
    const h = harness(() => new Promise<void>(resolve => setTimeout(resolve, 1)))
    // A turn is already running; three lines arrive while busy.
    h.setBusy(true)
    h.queueInput('A')
    h.queueInput('B')
    h.queueInput('C')
    expect(h.started).toEqual([])          // nothing starts while busy
    expect(h.queue.list()).toEqual(['A', 'B', 'C'])

    // The running turn settles -> release one and start it (production wiring).
    h.setBusy(false)
    const first = h.queue.releaseNext()
    if (first !== undefined) h.startTurn(first)

    await new Promise<void>(resolve => setTimeout(resolve, 60))
    expect(h.started).toEqual(['A', 'B', 'C'])   // three turns, not one merged
    expect(h.queue.list()).toEqual([])
  })

  it('drains a long queue without exhausting the stack', async () => {
    const h = harness(() => Promise.resolve())
    h.setBusy(true)
    const count = 2000
    for (let i = 0; i < count; i += 1) h.queueInput(`m${i}`)
    h.setBusy(false)
    // Kick the drain exactly like the production finally does.
    const kick = (): void => {
      const next = h.queue.releaseNext()
      if (next !== undefined) {
        h.started.push(next)
        void Promise.resolve().finally(kick)
      }
    }
    kick()
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    expect(h.started).toHaveLength(count)
    expect(h.started[0]).toBe('m0')
    expect(h.started[count - 1]).toBe(`m${count - 1}`)
  })
})
