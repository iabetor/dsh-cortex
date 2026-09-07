/**
 * dsh-cortex pager overlay — a simple full-height viewer for long text
 * (e.g. `/bash` full tool outputs). Renders a slice of `lines` into a fixed
 * viewport; ↑/↓ and PgUp/PgDn scroll, `q`/Esc closes. No external scroll
 * library — plain offset state, so it never misbehaves like ScrollView.
 *
 * @module dsh-cortex/tui/pager
 */

import React, { useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'

/** Props for the pager overlay. */
export interface PagerProps {
  title: string
  /** Pre-split lines (may contain ANSI-free plain text). */
  lines: string[]
  /** Called with undefined on close. */
  onClose: () => void
}

/**
 * A scrollable text viewer occupying the full terminal. ↑/↓/PgUp/PgDn scroll,
 * `q`/Esc closes.
 */
export function PagerOverlay(props: PagerProps): React.JSX.Element {
  const { title, lines, onClose } = props
  const { stdout } = useStdout()
  // Reserve 3 rows for header + 2 for footer hint.
  const viewportHeight = Math.max(5, (stdout.rows ?? 24) - 5)
  const [offset, setOffset] = useState(0)

  const maxOffset = Math.max(0, lines.length - viewportHeight)

  useInput((_input, key) => {
    if (key.upArrow || key.pageUp) {
      setOffset(o => Math.max(0, o - (key.pageUp ? viewportHeight : 1)))
      return
    }
    if (key.downArrow || key.pageDown) {
      setOffset(o => Math.min(maxOffset, o + (key.pageDown ? viewportHeight : 1)))
      return
    }
    if (key.home) {
      setOffset(0)
      return
    }
    if (key.end) {
      setOffset(maxOffset)
      return
    }
    if (key.escape || _input === 'q') {
      onClose()
    }
  })

  const visible = lines.slice(offset, offset + viewportHeight)
  const percent = lines.length === 0 ? 100 : Math.round(((offset + viewportHeight) / lines.length) * 100)

  return (
    <Box flexDirection="column" height="100%" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>{title}</Text>
        <Text dimColor>  ({lines.length} 行, {percent}%)</Text>
        <Text dimColor>  ↑/↓/PgUp/PgDn 滚动 · q 关闭</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {visible.map((line, i) => (
          <Text key={offset + i} wrap="wrap">{line}</Text>
        ))}
        {lines.length === 0 && <Text dimColor>— 空 —</Text>}
      </Box>
      <Text dimColor>{'─'.repeat(50)}</Text>
    </Box>
  )
}
