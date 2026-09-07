/**
 * dsh-cortex resume picker — an ink selection list shown before the main TUI
 * when the user asks to resume (`--resume` without an id). Sessions are
 * grouped by the current cwd (codex-style): only sessions created in this
 * working directory are listed, newest first.
 *
 * The picker renders inside the same ink instance the runner already created
 * (or creates one); it resolves with the picked session id (or undefined when
 * the user cancels) and unmounts itself.
 *
 * @module dsh-cortex/tui/picker
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { DiscoveredSession } from '../sessions.ts'
import { relativeTime } from '../sessions.ts'

/** Props for the resume picker. */
export interface PickerProps {
  /** Sessions to choose from (newest first). */
  sessions: readonly DiscoveredSession[]
  /** Called with the chosen session id; undefined when the user cancels. */
  onPick: (result: string | undefined) => void
  /** The cwd these sessions are grouped under (for the header). */
  cwd: string
}

/**
 * A compact selectable list. Enter picks the highlighted row; `q`/Esc cancels
 * (the caller starts a fresh session instead).
 */
export function ResumePicker(props: PickerProps): React.JSX.Element {
  const { sessions, onPick, cwd } = props
  const [cursor, setCursor] = useState(0)

  useInput((input, key) => {
    if (key.upArrow) {
      if (sessions.length > 0) setCursor(c => (c - 1 + sessions.length) % sessions.length)
      return
    }
    if (key.downArrow) {
      if (sessions.length > 0) setCursor(c => (c + 1) % sessions.length)
      return
    }
    if (key.return) {
      const picked = sessions[cursor]
      onPick(picked === undefined ? undefined : picked.id)
      return
    }
    if (input === 'q' || key.escape) {
      onPick(undefined)
      return
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>Resume a session in </Text>
        <Text color="cyan" dimColor>{cwd}</Text>
      </Box>
      <Text dimColor>↑/↓ navigate · Enter resume · q cancel (new session)</Text>
      <Box marginTop={1} flexDirection="column">
        {sessions.length === 0 && <Text dimColor>— no sessions in this directory —</Text>}
        {sessions.map((session, index) => (
          <Box key={session.id}>
            <Text color={index === cursor ? 'green' : undefined} bold={index === cursor}>
              {index === cursor ? '❯ ' : '  '}
              {session.title ?? shortId(session.id)}
            </Text>
            <Text dimColor>  {relativeTime(session.mtimeMs)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/** Trim a session id for display: session-xxxxxxxx… or bare uuid start. */
function shortId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 23)}…`
}
