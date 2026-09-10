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
