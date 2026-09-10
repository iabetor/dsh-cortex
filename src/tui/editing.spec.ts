import { describe, expect, it } from 'vitest'
import {
  clampCursor,
  deleteBackward,
  deleteBackwardWord,
  deleteForward,
  deleteForwardWord,
  insertAt,
  killToLineEnd,
  killToLineStart,
  moveLineEnd,
  moveLineStart,
} from './editing.ts'

describe('insertAt', () => {
  it('inserts at the cursor and advances past the inserted text', () => {
    expect(insertAt('ac', 1, 'b')).toEqual({ value: 'abc', cursor: 2 })
  })

  it('appends at the end', () => {
    expect(insertAt('ab', 2, 'cd')).toEqual({ value: 'abcd', cursor: 4 })
  })
})

describe('deleteBackward / deleteForward', () => {
  it('removes the char before the cursor', () => {
    expect(deleteBackward('abc', 2)).toEqual({ value: 'ac', cursor: 1 })
  })

  it('is a no-op at offset 0', () => {
    expect(deleteBackward('abc', 0)).toEqual({ value: 'abc', cursor: 0 })
  })

  it('removes the char at the cursor', () => {
    expect(deleteForward('abc', 1)).toEqual({ value: 'ac', cursor: 1 })
  })

  it('is a no-op at the end', () => {
    expect(deleteForward('abc', 3)).toEqual({ value: 'abc', cursor: 3 })
  })
})

describe('word deletion (Ctrl+W / Alt+D)', () => {
  it('deletes the word before the cursor, including trailing space', () => {
    expect(deleteBackwardWord('foo bar', 7)).toEqual({ value: 'foo ', cursor: 4 })
  })

  it('deletes only the partial word when inside it', () => {
    expect(deleteBackwardWord('foo bar', 6)).toEqual({ value: 'foo r', cursor: 4 })
  })

  it('skips whitespace then the word', () => {
    expect(deleteBackwardWord('foo   ', 6)).toEqual({ value: '', cursor: 0 })
  })

  it('deletes the word after the cursor, skipping the leading space', () => {
    expect(deleteForwardWord('foo bar', 3)).toEqual({ value: 'foo', cursor: 3 })
  })
})

describe('kill line (Ctrl+U / Ctrl+K)', () => {
  it('Ctrl+U clears everything before the cursor on a single line', () => {
    // The common case: cursor at the end -> whole draft cleared.
    expect(killToLineStart('hello world', 11)).toEqual({ value: '', cursor: 0 })
  })

  it('Ctrl+U stops at the current line start in a multi-line draft', () => {
    // cursor sits inside the second line, so only that line's prefix is killed.
    expect(killToLineStart('one\ntwo', 5)).toEqual({ value: 'one\nwo', cursor: 4 })
  })

  it('Ctrl+K clears to the end of the current line', () => {
    expect(killToLineEnd('one\ntwo', 4)).toEqual({ value: 'one\n', cursor: 4 })
  })

  it('Ctrl+K clears the tail on the last line', () => {
    expect(killToLineEnd('hello', 2)).toEqual({ value: 'he', cursor: 2 })
  })
})

describe('line movement (Ctrl+A / Ctrl+E)', () => {
  it('moves to the start of the current line', () => {
    expect(moveLineStart('one\ntwo', 6)).toEqual({ value: 'one\ntwo', cursor: 4 })
  })

  it('moves to the end of the current line', () => {
    expect(moveLineEnd('one\ntwo', 4)).toEqual({ value: 'one\ntwo', cursor: 7 })
  })
})

describe('clampCursor', () => {
  it('clamps both ends', () => {
    expect(clampCursor(-5, 'abc')).toBe(0)
    expect(clampCursor(99, 'abc')).toBe(3)
  })
})
