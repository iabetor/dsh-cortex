/**
 * dsh-cortex transcript overlay — full-screen interactive viewer for the
 * committed transcript (Ctrl+O). Mirrors codex's Ctrl+T pager: self-managed
 * row offset, render only the visible slice, Enter expands/collapses a tool
 * output or reasoning block in place.
 *
 * @module dsh-cortex/tui/transcript-overlay
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'

/** One overlay row (a committed line plus its expanded state). */
export type OverlayLineKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'separator'
export interface OverlayLine {
  id: number
  kind: OverlayLineKind
  /** Collapsed summary text. */
  text: string
  /** Full text when expandable (tool output / reasoning body). */
  fullText?: string
  expanded: boolean
}

/** Props for the transcript overlay. */
export interface TranscriptOverlayProps {
  lines: OverlayLine[]
  onClose: () => void
  /** Toggle expand/collapse by committed line id. */
  onToggle: (id: number) => void
  /** Toggle verbose reasoning (Ctrl+O inside overlay). */
  onToggleVerbose: () => void
}

/** Split long text into display lines (plain char wrap at terminal width). */
function splitText(text: string, width: number): string[] {
  if (text === '') return []
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw.length <= width) {
      lines.push(raw)
    } else {
      for (let i = 0; i < raw.length; i += width) {
        lines.push(raw.slice(i, i + width))
      }
    }
  }
  return lines
}

/** Render one overlay row into display lines given terminal width. */
function rowLines(line: OverlayLine, width: number): string[] {
  switch (line.kind) {
    case 'separator':
      return ['─'.repeat(Math.min(40, width))]
    case 'user':
      return splitText(`❯ ${line.text}`, width)
    case 'assistant':
      return splitText(`● ${line.text}`, width)
    case 'reasoning': {
      // Full text always visible (codex-aligned, dim+italic in main view).
      return splitText(`• ${line.text}`, width)
    }
    case 'tool': {
      const icon = line.fullText === undefined || line.fullText === '' ? '⏳' : '✓'
      const head = `${icon} ${line.text}`
      if (!line.expanded) {
        const hint = line.fullText !== undefined && line.fullText !== '' ? '  [Enter 展开输出]' : ''
        return splitText(`${head}${hint}`, width)
      }
      const out: string[] = splitText(head, width)
      if (line.fullText !== undefined && line.fullText !== '') {
        out.push(...splitText(line.fullText, width))
      } else {
        out.push('… running')
      }
      return out
    }
    case 'system':
      return splitText(line.text, width)
  }
}

/**
 * Full-screen transcript viewer: ↑/↓ move the row cursor (auto-scrolling to
 * keep it visible), Enter expands/collapses tool output or reasoning, PgUp/
 * PgDn page, q/Esc closes.
 */
export function TranscriptOverlay(props: TranscriptOverlayProps): React.JSX.Element {
  const { lines, onClose, onToggle, onToggleVerbose } = props
  const { stdout } = useStdout()
  const width = Math.max(20, (stdout.columns ?? 80) - 2)
  const viewportHeight = Math.max(5, (stdout.rows ?? 24) - 3)

  const [cursor, setCursor] = useState(() => Math.max(0, lines.length - 1))
  const [scrollTop, setScrollTop] = useState(0)

  // Per-row display heights for the current width.
  const heights = useMemo(() => lines.map(l => rowLines(l, width).length), [lines, width])
  const totalLines = useMemo(() => heights.reduce((a, b) => a + b, 0), [heights])
  const maxScroll = Math.max(0, totalLines - viewportHeight)

  /** Display-line offset of a row's top. */
  const rowOffset = (row: number): number => {
    let acc = 0
    for (let i = 0; i < row; i++) acc += heights[i] ?? 1
    return acc
  }

  /** Clamp and set scrollTop (handles the initial bottom sentinel). */
  const setScroll = (s: number): void => {
    setScrollTop(Math.min(Math.max(0, s), maxScroll))
  }

  /** Move the row cursor by delta and keep it visible.
   * NOTE: never call setState inside another setState updater — React may
   * re-run updaters and that nesting caused an infinite loop / OOM here. */
  const moveCursor = (delta: number): void => {
    const cur = cursor
    const next = Math.min(Math.max(0, cur + delta), Math.max(0, lines.length - 1))
    setCursor(next)
    const top = rowOffset(next)
    const bottom = top + (heights[next] ?? 1)
    setScrollTop(s => {
      const clamped = Math.min(Math.max(0, s), maxScroll)
      if (clamped + viewportHeight <= top) return Math.min(maxScroll, top) // below window
      if (top < clamped) return Math.max(0, top) // above window
      return clamped
    })
  }

  useInput((input, key) => {
    if (key.ctrl && (input === 'o' || input === '\x0f')) {
      onToggleVerbose()
      return
    }
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow) {
      moveCursor(-1)
      return
    }
    if (key.downArrow) {
      moveCursor(1)
      return
    }
    if (key.pageUp) {
      setScroll((scrollTop ?? 0) - Math.max(1, viewportHeight - 2))
      return
    }
    if (key.pageDown) {
      setScroll((scrollTop ?? 0) + Math.max(1, viewportHeight - 2))
      return
    }
    if (key.home) {
      setScroll(0)
      setCursor(0)
      return
    }
    if (key.end) {
      setScroll(maxScroll)
      setCursor(Math.max(0, lines.length - 1))
      return
    }
    if (key.return) {
      const line = lines[cursor]
      if (line !== undefined) onToggle(line.id)
      return
    }
    void input
  })

  // Initial scroll: pin to bottom on first layout (effect, not render).
  const initializedRef = useRef(false)
  const [pinnedBottom, setPinnedBottom] = useState(true)
  useEffect(() => {
    if (!initializedRef.current && totalLines > 0) {
      initializedRef.current = true
      setScrollTop(maxScroll)
      setPinnedBottom(false)
    }
  }, [totalLines, maxScroll])

  // Effective scroll: after init, use scrollTop directly.
  const effectiveScroll = pinnedBottom ? maxScroll : Math.min(Math.max(0, scrollTop), maxScroll)

  // Visible rows overlapping [effectiveScroll, effectiveScroll + viewport).
  const visible: { row: number }[] = []
  {
    let acc = 0
    for (let r = 0; r < lines.length; r++) {
      const h = heights[r] ?? 1
      if (acc + h > effectiveScroll && acc < effectiveScroll + viewportHeight) {
        visible.push({ row: r })
      }
      acc += h
    }
  }

  const percent = totalLines === 0 ? 100 : Math.min(100, Math.round(((effectiveScroll + viewportHeight) / totalLines) * 100))

  return (
    <Box flexDirection="column" height="100%" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>会话内容</Text>
        <Text dimColor>  ({lines.length} 块, {totalLines} 行, {percent}%)</Text>
        <Text dimColor>  ↑/↓ 选行 · Enter 展开 · PgUp/PgDn 翻页 · Ctrl+O verbose · q 退出</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {visible.map(({ row }) => {
          const line = lines[row]
          if (line === undefined) return null
          const isCursor = row === cursor
          const rowTop = rowOffset(row)
          // Slice the row's display lines to the visible window.
          const display = rowLines(line, width)
          const skip = Math.max(0, effectiveScroll - rowTop)
          const remain = viewportHeight - Math.max(0, rowTop - effectiveScroll)
          const slice = display.slice(skip, skip + Math.max(0, remain))
          return (
            <Box key={line.id} flexDirection="column">
              {slice.map((l, i) => (
                <Text key={i} color={isCursor ? 'magenta' : undefined} bold={isCursor && i === 0}>
                  {l}
                </Text>
              ))}
            </Box>
          )
        })}
        {lines.length === 0 && <Text dimColor>— 空会话 —</Text>}
      </Box>
      <Text dimColor>{'─'.repeat(Math.min(50, width))}</Text>
    </Box>
  )
}
