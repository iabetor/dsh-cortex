/**
 * Pure draft-editing operations for cortex's composer, in the Emacs/readline
 * family codex uses (`keymap.rs` → `editor` defaults).
 *
 * Kept separate from the React component so the exact cursor/value outcomes
 * can be unit-tested: the input box is the one place where an off-by-one is
 * immediately visible to the user.
 *
 * @module dsh-cortex/tui/editing
 */

/** One edit result: the new draft and where the cursor lands in it. */
export interface EditResult {
  readonly value: string
  readonly cursor: number
}

/** Clamp a cursor offset into `[0, value.length]`. */
export function clampCursor(cursor: number, value: string): number {
  if (cursor < 0) return 0
  if (cursor > value.length) return value.length
  return cursor
}

/** Insert `text` at `cursor`. */
export function insertAt(value: string, cursor: number, text: string): EditResult {
  const at = clampCursor(cursor, value)
  return {
    value: value.slice(0, at) + text + value.slice(at),
    cursor: at + text.length,
  }
}

/** Delete one character before the cursor (Backspace). */
export function deleteBackward(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  if (at === 0) return { value, cursor: at }
  return {
    value: value.slice(0, at - 1) + value.slice(at),
    cursor: at - 1,
  }
}

/** Delete one character at/after the cursor (Delete). */
export function deleteForward(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  if (at >= value.length) return { value, cursor: at }
  return {
    value: value.slice(0, at) + value.slice(at + 1),
    cursor: at,
  }
}

/** Index just past the previous word boundary, skipping trailing whitespace. */
function previousWordStart(value: string, cursor: number): number {
  let i = clampCursor(cursor, value)
  while (i > 0 && /\s/.test(value[i - 1] as string)) i -= 1
  while (i > 0 && !/\s/.test(value[i - 1] as string)) i -= 1
  return i
}

/** Index of the next word boundary, skipping leading whitespace. */
function nextWordEnd(value: string, cursor: number): number {
  let i = clampCursor(cursor, value)
  while (i < value.length && /\s/.test(value[i] as string)) i += 1
  while (i < value.length && !/\s/.test(value[i] as string)) i += 1
  return i
}

/** Delete the word before the cursor (Ctrl+W / Alt+Backspace). */
export function deleteBackwardWord(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  const start = previousWordStart(value, at)
  return {
    value: value.slice(0, start) + value.slice(at),
    cursor: start,
  }
}

/** Delete the word after the cursor (Alt+D). */
export function deleteForwardWord(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  const end = nextWordEnd(value, at)
  return {
    value: value.slice(0, at) + value.slice(end),
    cursor: at,
  }
}

/** Delete from the cursor back to the start of the line (Ctrl+U). */
export function killToLineStart(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  const start = value.lastIndexOf('\n', at - 1) + 1
  return {
    value: value.slice(0, start) + value.slice(at),
    cursor: start,
  }
}

/** Delete from the cursor to the end of the line (Ctrl+K). */
export function killToLineEnd(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  const found = value.indexOf('\n', at)
  const end = found === -1 ? value.length : found
  return {
    value: value.slice(0, at) + value.slice(end),
    cursor: at,
  }
}

/** Move to the start of the current line (Ctrl+A / Home). */
export function moveLineStart(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  return { value, cursor: value.lastIndexOf('\n', at - 1) + 1 }
}

/** Move to the end of the current line (Ctrl+E / End). */
export function moveLineEnd(value: string, cursor: number): EditResult {
  const at = clampCursor(cursor, value)
  const found = value.indexOf('\n', at)
  return { value, cursor: found === -1 ? value.length : found }
}
