import { describe, expect, it } from 'vitest'
import { DraftHistory } from './history.ts'

describe('DraftHistory', () => {
  it('does nothing when nothing was submitted', () => {
    const h = new DraftHistory()
    expect(h.up('', 0)).toEqual({ handled: false, value: '', cursor: 0 })
    expect(h.down('', 0)).toEqual({ handled: false, value: '', cursor: 0 })
  })

  it('recalls entries newest-first on an empty draft', () => {
    const h = new DraftHistory()
    h.record('first')
    h.record('second')
    expect(h.up('', 0)).toEqual({ handled: true, value: 'second', cursor: 6 })
    expect(h.up('second', 6)).toEqual({ handled: true, value: 'first', cursor: 5 })
  })

  it('walks back down to the recalled entry, then restores nothing extra', () => {
    const h = new DraftHistory()
    h.record('first')
    h.record('second')
    // Empty draft starts browsing (codex only starts recall from an empty box).
    expect(h.up('', 0)).toEqual({ handled: true, value: 'second', cursor: 6 })
    // Older entry.
    expect(h.up('second', 6)).toEqual({ handled: true, value: 'first', cursor: 5 })
    // Down returns to the newer entry.
    expect(h.down('first', 5)).toEqual({ handled: true, value: 'second', cursor: 6 })
    // Down past the newest restores the (empty) draft we started from.
    expect(h.down('second', 6)).toEqual({ handled: true, value: '', cursor: 0 })
  })

  it('stops at the oldest entry instead of wrapping', () => {
    const h = new DraftHistory()
    h.record('only')
    expect(h.up('', 0)).toEqual({ handled: true, value: 'only', cursor: 4 })
    expect(h.up('only', 4)).toEqual({ handled: true, value: 'only', cursor: 4 })
  })

  it('leaves a NON-empty draft alone so multiline cursor movement works', () => {
    const h = new DraftHistory()
    h.record('first')
    // A fresh draft that is not the recalled entry: Up is cursor movement.
    // (codex starts recall only from an empty box, like bash/zsh.)
    expect(h.up('typing something', 5)).toEqual({ handled: false, value: 'typing something', cursor: 5 })
  })

  it('ignores empty and immediately-repeated submissions', () => {
    const h = new DraftHistory()
    h.record('same')
    h.record('same')
    h.record('   ')
    expect(h.size).toBe(1)
  })

  it('reset() stops browsing', () => {
    const h = new DraftHistory()
    h.record('x')
    h.up('', 0)
    h.reset()
    // After reset a non-empty draft is not treated as a recalled entry.
    expect(h.down('x', 1).handled).toBe(false)
  })
})
