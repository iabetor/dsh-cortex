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
import { Box, Text, useInput } from 'ink'
import chalk from 'chalk'

/** Props mirroring ink-text-input. */
export interface CortexTextInputProps {
  value: string
  placeholder?: string
  focus?: boolean
  mask?: string
  showCursor?: boolean
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
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
  } = props

  const [state, setState] = useState({
    cursorOffset: (originalValue || '').length,
    cursorWidth: 0,
  })
  const { cursorOffset, cursorWidth } = state

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
  let renderedValue = value
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined
  // Fake mouse cursor: keep it simple like upstream — an inverse space.
  if (showCursor && focus) {
    renderedPlaceholder = undefined
    if (cursorOffset === renderedValue.length) {
      renderedValue += chalk.inverse(' ')
    } else {
      renderedValue =
        renderedValue.slice(0, cursorOffset)
        + chalk.inverse(renderedValue[cursorOffset] ?? ' ')
        + renderedValue.slice(cursorOffset + 1)
    }
  }

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

  return (
    <Text>
      {renderedPlaceholder ?? renderedValue}
    </Text>
  )
}

