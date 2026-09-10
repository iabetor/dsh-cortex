/**
 * dsh-cortex text input — a fork of ink-text-input (MIT) that never lets
 * Ctrl/Meta chord characters (Ctrl+O, Ctrl+E, …) leak into the draft.
 *
 * ink-text-input appends ANY printable input character, including the letter
 * produced by a ctrl chord (ink reports Ctrl+O as input='o'), so global
 * shortcut keys would type letters into the box. This variant skips the
 * append when the key carries ctrl/meta, leaving those chords to global
 * useInput handlers (verbose reasoning toggle, expand tool card, …).
 *
 * @module dsh-cortex/tui/text-input
 */

import React, { useState, useEffect } from 'react'
import { Box, Text, useInput, usePaste, useStdout } from 'ink'
import chalk from 'chalk'
import stringWidth from 'string-width'
import {
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
import type { DraftHistory } from './history.ts'

/** Props mirroring ink-text-input. */
export interface CortexTextInputProps {
  value: string
  placeholder?: string
  focus?: boolean
  mask?: string
  showCursor?: boolean
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  /**
   * Usable display width for the text (excluding the prompt/border the caller
   * renders). When omitted, the terminal width minus a small margin is used.
   * Needed because a single-line <Text> that overflows soft-wraps and ink
   * mis-measures its height, clipping every wrapped row.
   */
  width?: number
  /**
   * Shell-style draft history for Up/Down recall. The caller owns the instance
   * so entries survive across submits; omit to disable history recall.
   */
  history?: DraftHistory
  /**
   * Called with the submitted draft so the caller can record it in `history`.
   * The input component never records on its own: only the caller knows whether
   * a draft was actually accepted.
   */
  onSubmitted?: (value: string) => void
}

/** Display width of one string (CJK/emoji count double). */
function sw(s: string): number {
  return stringWidth(s)
}

/**
 * Pre-wrap plain text into display lines at a fixed DISPLAY width, so every
 * line is one physical row ink can measure correctly. Explicit '\n' starts a
 * new line; an over-long line is greedily split by display width.
 */
function wrapByWidth(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    if (width <= 0 || sw(raw) <= width) {
      out.push(raw)
      continue
    }
    let rest = raw
    while (sw(rest) > width) {
      let acc = ''
      let w = 0
      for (const ch of rest) {
        const cw = sw(ch)
        if (w + cw > width) break
        acc += ch
        w += cw
      }
      // A single char wider than the row would loop forever; force progress.
      if (acc === '') acc = rest.slice(0, 1)
      out.push(acc)
      rest = rest.slice(acc.length)
    }
    out.push(rest)
  }
  return out
}

/**
 * Map a Ctrl/Meta chord to a readline-style edit, mirroring codex's editor
 * keymap (`keymap.rs`). Returning `undefined` means "not an editing chord", so
 * the caller can leave the key to the app shell.
 *
 * Note: ink reports Ctrl+<letter> with `input` set to the bare letter, so the
 * chords are matched on `input` rather than a control character.
 * @param input - the key's text payload (the bare letter for a ctrl chord).
 * @param key - ink's modifier flags.
 * @param value - current draft.
 * @param cursor - current cursor offset.
 * @returns the edited draft, or undefined when the chord is not an edit.
 */
function applyEditingChord(
  input: string,
  key: { ctrl: boolean; meta: boolean },
  value: string,
  cursor: number,
): { value: string; cursor: number } | undefined {
  // Ctrl+U / Ctrl+K — the "clear this line" pair (Ctrl+U is the quick way to
  // drop a long draft: the cursor starts at the end, so it clears everything).
  if (key.ctrl && !key.meta) {
    switch (input) {
      case 'u': return killToLineStart(value, cursor)
      case 'k': return killToLineEnd(value, cursor)
      case 'w': return deleteBackwardWord(value, cursor)
      case 'a': return moveLineStart(value, cursor)
      case 'e': return moveLineEnd(value, cursor)
      case 'b': return { value, cursor: Math.max(0, cursor - 1) }
      case 'f': return { value, cursor: Math.min(value.length, cursor + 1) }
      case 'h': return deleteBackward(value, cursor)
      case 'd': return deleteForward(value, cursor)
      default: return undefined
    }
  }
  // Alt/Meta chords: word-wise edits and word movement.
  if (key.meta && !key.ctrl) {
    switch (input) {
      case 'd': return deleteForwardWord(value, cursor)
      case 'b': return { value, cursor: previousWordBoundary(value, cursor) }
      case 'f': return { value, cursor: nextWordBoundary(value, cursor) }
      default: return undefined
    }
  }
  return undefined
}

/** Index of the word boundary before the cursor (Alt+B). */
function previousWordBoundary(value: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, value.length))
  while (i > 0 && /\s/.test(value[i - 1] as string)) i -= 1
  while (i > 0 && !/\s/.test(value[i - 1] as string)) i -= 1
  return i
}

/** Index of the word boundary after the cursor (Alt+F). */
function nextWordBoundary(value: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, value.length))
  while (i < value.length && /\s/.test(value[i] as string)) i += 1
  while (i < value.length && !/\s/.test(value[i] as string)) i += 1
  return i
}

/**
 * Single-line text input with ctrl/meta chord protection.
 */
export function CortexTextInput(props: CortexTextInputProps): React.JSX.Element {
  const {
    value: originalValue,
    placeholder = '',
    focus = true,
    mask,
    showCursor = true,
    onChange,
    onSubmit,
    onSubmitted,
    width,
    history,
  } = props

  const { stdout } = useStdout()
  // Rows must fit one physical line: fall back to the terminal width minus the
  // prompt + border margin when the caller does not pass an explicit width.
  // `||` (not ??) matters: a fresh PTY can report columns as 0, and a tiny or
  // negative result would wrap every character onto its own row.
  const columns = width ?? (stdout.columns || 80) - 6
  const usableWidth = Math.max(20, columns)

  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  })
  const { cursorOffset } = state

  useEffect(() => {
    setState(previousState => {
      if (!focus || !showCursor) return previousState
      const newValue = originalValue || ''
      if (previousState.cursorOffset > newValue.length - 1) {
        return { cursorOffset: newValue.length, cursorWidth: 0 }
      }
      return previousState
    })
  }, [originalValue, focus, showCursor])

  const cursorActualWidth = 0 // no highlight-paste support
  const value = mask ? mask.repeat(originalValue.length) : originalValue
  const placeholderText = placeholder ? chalk.grey(placeholder) : undefined
  // Wrap the PLAIN text (never the escape-encoded string) into display rows,
  // then draw the cursor on the row/column it actually occupies. A single
  // overflowing <Text> would soft-wrap and ink would mis-measure its height,
  // hiding every row after the first.
  const rows = wrapByWidth(value, usableWidth)
  let cursorRow = rows.length - 1
  let cursorCol = (rows[cursorRow] ?? '').length
  if (value === '') {
    cursorRow = 0
    cursorCol = 0
  } else {
    // Walk the rows by CHARACTER count: cursorOffset and row.slice() are both
    // character indices, while sw() is display width. Mixing the two put the
    // cursor inside the text whenever a wrapped row held wide (CJK) glyphs.
    let remaining = cursorOffset
    for (let i = 0; i < rows.length; i += 1) {
      const rowLength = (rows[i] ?? '').length
      if (remaining <= rowLength) {
        cursorRow = i
        cursorCol = remaining
        break
      }
      remaining -= rowLength
    }
  }
  const showFakeCursor = showCursor && focus
  const renderedRows = rows.length === 0 ? [''] : rows

  // Bracketed paste (ink enables \x1b[?2004h while this hook is active):
  // pasted text arrives as ONE string, so its newlines are inserted verbatim
  // instead of being mistaken for Enter and submitting the first line.
  usePaste((pasted) => {
    if (!focus) return
    const text = pasted.replace(/\r\n?/g, '\n')
    const next = originalValue.slice(0, cursorOffset) + text + originalValue.slice(cursorOffset)
    setState({ cursorOffset: cursorOffset + text.length, cursorWidth: 0 })
    onChange(next)
  }, { isActive: focus })

  useInput((input, key) => {
    // Ctrl+C and Tab belong to the app shell (cancel / queue / steer).
    if ((key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
      return
    }

    // Up/Down: shell-style history recall when the draft allows it (empty box,
    // or continuing a recalled entry) — otherwise they are ordinary cursor
    // movement, so multiline editing keeps working (codex's rule).
    if (key.upArrow || key.downArrow) {
      if (history === undefined || !showCursor) return
      const step = key.upArrow
        ? history.up(originalValue, cursorOffset)
        : history.down(originalValue, cursorOffset)
      if (!step.handled) return
      setState({ cursorOffset: step.cursor, cursorWidth: 0 })
      if (step.value !== originalValue) onChange(step.value)
      return
    }

    if (key.return) {
      if (onSubmit) onSubmit(originalValue)
      onSubmitted?.(originalValue)
      return
    }

    // Readline/Emacs editing chords, matching codex's editor keymap. These must
    // be handled BEFORE the blanket ctrl/meta guard below (which exists only to
    // stop Ctrl+O/Ctrl+E-style chords from typing their letter into the draft).
    if (key.ctrl || key.meta) {
      const chord = applyEditingChord(input, key, originalValue, cursorOffset)
      if (chord !== undefined) {
        setState({ cursorOffset: chord.cursor, cursorWidth: 0 })
        if (chord.value !== originalValue) onChange(chord.value)
        return
      }
      return
    }
    if (key.escape) return

    let nextCursorOffset = cursorOffset
    let nextValue = originalValue
    let nextCursorWidth = 0

    if (key.leftArrow) {
      if (showCursor) nextCursorOffset--
    } else if (key.rightArrow) {
      if (showCursor) nextCursorOffset++
    } else if (key.backspace || key.delete) {
      const result = key.delete && !key.backspace
        ? deleteForward(originalValue, cursorOffset)
        : deleteBackward(originalValue, cursorOffset)
      nextValue = result.value
      nextCursorOffset = result.cursor
    } else {
      const result = insertAt(originalValue, cursorOffset, input)
      nextValue = result.value
      nextCursorOffset = result.cursor
      if (input.length > 1) nextCursorWidth = input.length
    }

    if (nextCursorOffset < 0) nextCursorOffset = 0
    if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length

    setState({ cursorOffset: nextCursorOffset, cursorWidth: nextCursorWidth })
    void cursorActualWidth
    if (nextValue !== originalValue) onChange(nextValue)
  })

  // Empty draft: show the placeholder on a single row.
  if (value === '' && placeholderText !== undefined) {
    return <Text>{placeholderText}</Text>
  }

  return (
    <Box flexDirection="column">
      {renderedRows.map((row, index) => {
        if (!showFakeCursor || index !== cursorRow) {
          return <Text key={index}>{row}</Text>
        }
        // Draw the fake cursor (inverse space) at its column on its own row.
        const before = row.slice(0, cursorCol)
        const at = row.slice(cursorCol, cursorCol + 1)
        const after = row.slice(cursorCol + 1)
        return (
          <Text key={index}>
            {before}
            {chalk.inverse(at === '' ? ' ' : at)}
            {after}
          </Text>
        )
      })}
    </Box>
  )
}

