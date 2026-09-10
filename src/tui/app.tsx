/**
 * dsh-cortex TUI — codex-aligned layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │ status: model · cwd · ⏳ · verbose   │  ← status bar (fixed top)
 *   ├──────────────────────────────────────┤
 *   │ <Static> committed transcript        │  ← committed history rows,
 *   │   ❯ user message                     │     appended into terminal
 *   │   ● assistant reply                  │     scrollback (never redrawn)
 *   │   ⏳ bash: ls /tmp                   │
 *   │   • thinking ⠋ (animated)          │
 *   ├──────────────────────────────────────┤
 *   │ active streaming line (live)         │  ← dynamic area (repainted)
 *   ├──────────────────────────────────────┤
 *   │ ❯ input box (bottom, fixed)          │
 *   └──────────────────────────────────────┘
 *
 * Like codex: completed rows are committed to the terminal's native
 * scrollback via <Static> (append-only, stable); only the bottom active
 * region redraws. Tool outputs and full reasoning are viewed in a
 * Ctrl+O full-screen interactive overlay (up/down to pick a row, Enter to
 * expand bash output / reasoning text in place).
 *
 * @module dsh-cortex/tui/app
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Static, Text, useAnimation, useApp, useInput } from 'ink'
import { CortexTextInput } from './text-input.tsx'
import type { CortexStore } from './store.ts'
import type { CommittedLine } from './store.ts'
import { PickerOverlay } from './picker-overlay.tsx'
import { PagerOverlay } from './pager.tsx'
import { TranscriptOverlay } from './transcript-overlay.tsx'
import { QuestionOverlay } from './question-overlay.tsx'
import { ApprovalOverlay } from './approval-overlay.tsx'

/** Props for the root TUI app. */
export interface CortexAppProps {
  store: CortexStore
  /** Submit one user line (Enter: queue when busy / send when idle). */
  onSubmit: (text: string) => void
  /** Steer a line into the running turn (Tab while busy / send when idle). */
  onSteer: (text: string) => void
  /** Slash command handler (e.g. /model, /effort, /quit). */
  onCommand: (cmd: string, args: string) => void
  /** Picker overlay selection result (key or undefined on cancel). */
  onPickResult: (key: string | undefined) => void
  /** Cancel the running turn (Escape while busy). */
  onCancel: () => void
  /** User requested exit. */
  onExit: () => void
}

/** Render one committed row (always collapsed — expand lives in the overlay). */
function CommittedRow({ line }: { line: CommittedLine }): React.JSX.Element {
  switch (line.kind) {
    case 'separator':
      return <Text dimColor>{'─'.repeat(40)}</Text>
    case 'user':
      return (
        <Box>
          <Text color="blue" bold wrap="wrap">{'❯ '}{line.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box>
          <Text color="green" bold>{'● '}</Text>
          <Text wrap="wrap">{line.text}</Text>
        </Box>
      )
    case 'reasoning':
      // Codex-aligned: full reasoning stays in the transcript, rendered
      // dim+italic (ANSI dim, no fixed color → adapts to light/dark themes)
      // with a "• " prefix like codex's ReasoningSummaryCell.
      return <Text dimColor italic wrap="wrap">{`• ${line.text}`}</Text>
    case 'tool': {
      const icon = line.fullText === undefined || line.fullText === '' ? '⏳' : '✓'
      return (
        <Box>
          <Text color="cyan">{icon} {line.text}</Text>
          {line.fullText !== undefined && line.fullText !== '' && <Text dimColor>  (Ctrl+O 查看)</Text>}
        </Box>
      )
    }
    case 'system':
      return <Text color="gray" dimColor wrap="wrap">{line.text}</Text>
  }
}

/** Spinner glyphs (braille) driven by ink's animation frame. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** 状态栏里的权限模式短标签（简体中文）。 */
function sandboxLabel(mode: string): string {
  switch (mode) {
    case 'read-only': return '只读'
    case 'danger-full-access': return '⚠ 完全权限'
    case 'workspace-write': return '工作区可写'
    default: return mode
  }
}

/** 状态栏里的耗时展示：毫秒 → 人类可读（不足 1 分钟用秒，超过用 分:秒）。 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 100) ) / 10
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/** Animated "thinking" indicator for the live reasoning line. */
function ThinkingSpinner(props: { verbose: boolean; text: string }): React.JSX.Element {
  const { verbose, text } = props
  const { frame } = useAnimation({ interval: 80 })
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋'
  return (
    <Text dimColor italic wrap="wrap">
      {verbose ? `• ${text} ${glyph}` : `• thinking ${glyph}`}
    </Text>
  )
}

/**
 * Root ink app: status bar + committed transcript (Static) + active line + input.
 */
export function CortexApp(props: CortexAppProps): React.JSX.Element {
  const { store, onSubmit, onSteer, onCommand, onPickResult, onCancel, onExit } = props
  const subscribe = useRef(store.subscribe.bind(store)).current
  const getSnapshot = useRef(() => store.snapshot()).current
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const [input, setInput] = useState('')
  const inputRef = useRef(input)
  inputRef.current = input
  const { exit } = useApp()
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  // Turn duration: tick once per second while a turn runs, so the status-bar
  // timer actually advances (the store only notifies on events, not on time).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!state.busy) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [state.busy])
  const turnElapsed = state.busy
    ? (state.turnStartedAt === null ? null : now - state.turnStartedAt)
    : state.lastTurnMs

  useInput((inputChar, key) => {
    // Any full-screen overlay owns the keyboard while open; global chords
    // (Escape cancel, Ctrl+O, Tab steer) must not fire underneath it.
    const s = store.snapshot()
    const overlayOpen = s.questions !== null && s.questions.length > 0
      || s.approval !== null
      || s.transcriptOverlay !== null
      || s.viewer !== null
      || s.picker !== null
    if (overlayOpen) {
      void inputChar
      return
    }
    // Escape cancels the running turn (no-op when idle).
    if (key.escape) {
      onCancel()
      return
    }
    // Ctrl+O opens the interactive transcript overlay (all tool outputs and
    // reasoning, expandable per row). Shift+Ctrl+O or a second Ctrl+O from
    // within the overlay toggles verbose reasoning instead.
    if (key.ctrl && (inputChar === 'o' || inputChar === '\x0f')) {
      // Only open the overlay when there is something to inspect.
      if (store.snapshot().committed.length > 0) {
        store.openTranscriptOverlay()
      }
      return
    }
    // Tab with a draft: steer into the running turn (busy) or send (idle).
    if (key.tab && inputRef.current.trim() !== '') {
      const line = inputRef.current.trim()
      setInput('')
      handleSubmitPath(line, true)
      return
    }
    void inputChar
  })

  /** Route a submitted line: slash commands first, then Enter (queue/send)
   *  or Tab (steer/send) semantics. */
  const handleSubmitPath = (line: string, viaTab: boolean): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    setInput('')

    // Slash commands.
    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/)
      const cmd = parts[0] ?? ''
      const args = parts.slice(1).join(' ')
      if (cmd === 'quit' || cmd === 'exit') {
        exitRef.current()
        exit()
        return
      }
      onCommand(cmd, args)
      return
    }

    if (viaTab) onSteer(trimmed)
    else onSubmit(trimmed)
  }

  const handleSubmit = (line: string): void => {
    handleSubmitPath(line, false)
  }

  const activeColor = state.activeKind === 'reasoning' ? 'yellow' : state.activeKind === 'text' ? 'green' : 'gray'
  const activePrefix = state.activeKind === 'reasoning' ? '… ' : state.activeKind === 'text' ? '● ' : ''
  const cursor = state.busy ? '▍' : ''

  // The main view (with <Static>) stays mounted across overlays: unmounting
  // Static resets its internal index and re-emits the whole committed
  // transcript, which smears blank lines over the terminal. Overlays paint on
  // top (absolute) while the main view remains mounted underneath.
  const overlay = state.questions !== null && state.questions.length > 0
    ? (
      <QuestionOverlay
        key={state.questions[0]?.id ?? 'batch'}
        questions={state.questions}
        onAnswer={(answer) => store.answerQuestion(answer)}
      />
    )
    : state.approval !== null
      ? (
        <ApprovalOverlay
          approval={state.approval}
          onDecision={(outcome, reason) => store.answerApproval(outcome, reason)}
        />
      )
      : state.transcriptOverlay !== null
        ? (
          <TranscriptOverlay
            lines={store.overlayLines()}
            onClose={() => store.closeTranscriptOverlay()}
            onToggle={(id) => store.toggleLine(id)}
            onToggleVerbose={() => store.toggleReasoning()}
          />
        )
        : state.viewer !== null
          ? (
            <PagerOverlay
              title={state.viewer.title}
              lines={state.viewer.lines}
              onClose={() => store.closeViewer()}
            />
          )
          : state.picker !== null
            ? (
              <PickerOverlay
                items={state.picker.items}
                title={state.picker.title}
                onPick={(key) => { store.closePicker(); onPickResult(key) }}
              />
            )
            : null

  // <Static> sits at a fixed tree position in BOTH branches so it never
  // unmounts across overlay open/close (unmounting resets its internal index
  // and re-emits the whole committed transcript → blank/duplicate lines).
  // Overlay open: hide the chrome (status/input/streaming), show overlay.
  // Overlay closed: full main view.
  return (
    <Box flexDirection="column" height="100%">
      {/* Status bar — hidden while an overlay is open */}
      {overlay === null && (
        <Box flexShrink={0} borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>{state.model || 'no model'}</Text>
          {state.effort !== '' && (
            <>
              <Text dimColor> · </Text>
              <Text color="cyan">effort: {state.effort}</Text>
            </>
          )}
          {state.sandboxMode !== '' && (
            <>
              <Text dimColor> · </Text>
              <Text color={state.sandboxMode === 'danger-full-access' ? 'yellow' : 'cyan'}>
                {sandboxLabel(state.sandboxMode)}
              </Text>
            </>
          )}
          {turnElapsed !== null && (
            <>
              <Text dimColor> · </Text>
              <Text color={state.busy ? 'yellow' : 'cyan'} dimColor={!state.busy}>
                ⏱ {formatDuration(turnElapsed)}
              </Text>
            </>
          )}
          <Text dimColor> · </Text>
          <Text color="cyan" dimColor>{state.cwd || '~'}</Text>
          {state.busy && <Text color="yellow">{' ⏳'}</Text>}
          <Text dimColor>  </Text>
          <Text color="gray" dimColor>
            {state.busy ? 'esc: 取消 · ' : ''}ctrl+o: 查看全部工具/思考
          </Text>
        </Box>
      )}

      {/* Committed transcript — appended to terminal scrollback, never
          redrawn. ALWAYS mounted (both branches) to keep its internal
          output index. */}
      <Static items={state.committed}>
        {(line) => <CommittedRow key={line.id} line={line} />}
      </Static>

      {overlay !== null ? (
        overlay
      ) : (
        <>
          {/* Active streaming line — in-place update. Reasoning shows an
              animated spinner (verbose mode streams the actual text). */}
          {state.activeKind === 'reasoning' && state.activeText !== '' && (
            <ThinkingSpinner verbose={state.showReasoning} text={state.activeText} />
          )}
          {state.activeKind === 'text' && state.activeText !== '' && (
            <Box flexShrink={0}>
              <Text color={activeColor} wrap="wrap">
                {activePrefix}{state.activeText}{cursor}
              </Text>
            </Box>
          )}
          {state.busy && state.activeText === '' && (
            <ThinkingSpinner verbose={false} text="" />
          )}

          {/* Input box — fixed at bottom */}
          <Box flexShrink={0} borderStyle="single" borderColor="green" paddingX={1}>
            <Text color="green" bold>{'❯ '}</Text>
            <CortexTextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder={state.busy ? 'agent running — Enter queue · Tab steer' : 'type a message… (/model, /quit, Ctrl+O 查看)'}
              focus
            />
          </Box>
        </>
      )}
    </Box>
  )
}
