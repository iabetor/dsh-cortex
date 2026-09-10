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
import { Box, Text, useInput, useStdout } from 'ink'
import chalk from 'chalk'
import stringWidth from 'string-width'

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
    width,
  } = props

  const { stdout } = useStdout()
  // Rows must fit one physical line: fall back to the terminal width minus the
  // prompt + border margin when the caller does not pass an explicit width.
  const usableWidth = Math.max(1, width ?? (stdout.columns ?? 80) - 6)

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
  let cursorCol = sw(rows[cursorRow] ?? '')
  if (value === '') {
    cursorRow = 0
    cursorCol = 0
  } else {
    let remaining = cursorOffset
    for (let i = 0; i < rows.length; i += 1) {
      const rowWidth = sw(rows[i] ?? '')
      // The cursor belongs to this row when it falls inside it (or exactly at
      // its end and this is the last row / the next row starts a new source line).
      if (remaining <= rowWidth) {
        cursorRow = i
        cursorCol = remaining
        break
      }
      remaining -= rowWidth
    }
  }
  const showFakeCursor = showCursor && focus
  const renderedRows = rows.length === 0 ? [''] : rows

  useInput((input, key) => {
    // Reserved keys that upstream ignores.
    if (key.upArrow || key.downArrow || (key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
      return
    }
    // KEY FIX: never treat ctrl/meta chords as text input. Without this,
    // Ctrl+O (verbose reasoning) and Ctrl+E (expand tool card) would type
    // "o"/"e" into the draft because ink reports their input as the letter.
    if (key.ctrl || key.meta || key.escape) {
      return
    }
    if (key.return) {
      if (onSubmit) onSubmit(originalValue)
      return
    }

    let nextCursorOffset = cursorOffset
    let nextValue = originalValue
    let nextCursorWidth = 0

    if (key.leftArrow) {
      if (showCursor) nextCursorOffset--
    } else if (key.rightArrow) {
      if (showCursor) nextCursorOffset++
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue = originalValue.slice(0, cursorOffset - 1) + originalValue.slice(cursorOffset)
        nextCursorOffset--
      }
    } else {
      nextValue = originalValue.slice(0, cursorOffset) + input + originalValue.slice(cursorOffset)
      nextCursorOffset += input.length
      if (input.length > 1) nextCursorWidth = input.length
    }

    if (cursorOffset < 0) nextCursorOffset = 0
    if (cursorOffset > originalValue.length) nextCursorOffset = originalValue.length

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

