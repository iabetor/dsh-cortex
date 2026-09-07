/**
 * dsh-cortex list picker — an ink selection list rendered as an overlay by
 * the main TUI (model catalog for /model, etc.). ↑/↓ move, Enter picks,
 * `q`/Esc cancels.
 *
 * The cursor stays bounded to `displayed.length` so a highlighted row is
 * always one of the visible rows; without that, typing many filters could
 * push the cursor onto a row past the visible 15-row cap and it would
 * silently fall out of view.
 *
 * @module dsh-cortex/tui/picker-overlay
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

/** One selectable row. */
export interface SelectItem {
  /** Stable key (model id / session id). */
  key: string
  /** Primary label shown bold when highlighted. */
  label: string
  /** Optional trailing dim hint (e.g. "current"). */
  hint?: string
}

/** Props for the picker overlay. */
export interface PickerOverlayProps {
  items: readonly SelectItem[]
  title: string
  onPick: (key: string | undefined) => void
}

/**
 * A full-width selection list. ↑/↓ navigate, Enter picks, `q`/Esc cancels.
 */
export function PickerOverlay(props: PickerOverlayProps): React.JSX.Element {
  const { items, title, onPick } = props
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')

  // Filter the list once, then cap to a visible window. Cursor math stays on
  // the rendered slice so highlighted rows are always on screen.
  const filtered = filter === ''
    ? items
    : items.filter(item => item.label.toLowerCase().includes(filter.toLowerCase()))
  const displayed = filtered.slice(0, 15)
  const displayLength = displayed.length

  useInput((input, key) => {
    if (key.upArrow) {
      if (displayLength > 0) setCursor(c => (c - 1 + displayLength) % displayLength)
      return
    }
    if (key.downArrow) {
      if (displayLength > 0) setCursor(c => (c + 1) % displayLength)
      return
    }
    if (key.return) {
      const picked = displayed[cursor]
      onPick(picked === undefined ? undefined : picked.key)
      return
    }
    if (key.backspace) {
      setFilter(f => f.slice(0, -1))
      setCursor(0)
      return
    }
    if (input === 'q' || key.escape) {
      onPick(undefined)
      return
    }
    if (/^[\x20-\x7e]$/.test(input)) {
      setFilter(f => f + input)
      setCursor(0)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
      <Box marginBottom={0}>
        <Text color="cyan" bold>{title}</Text>
        <Text dimColor>  ({filtered.length}/{items.length})</Text>
      </Box>
      <Text dimColor>type to filter · ↑/↓ move · Enter select · q cancel</Text>
      <Box flexDirection="column" marginTop={0}>
        {filtered.length === 0 && <Text dimColor>— no match —</Text>}
        {displayed.map((item, index) => (
          <Box key={item.key}>
            <Text color={index === cursor ? 'green' : undefined} bold={index === cursor}>
              {index === cursor ? '❯ ' : '  '}
              {item.label}
            </Text>
            {item.hint !== undefined && <Text dimColor>  {item.hint}</Text>}
          </Box>
        ))}
        {filtered.length > displayLength && (
          <Text dimColor>… +{filtered.length - displayLength} more (type to filter)</Text>
        )}
        {filter !== '' && <Text color="gray">filter: {filter}</Text>}
      </Box>
    </Box>
  )
}
