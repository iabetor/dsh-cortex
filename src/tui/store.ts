/**
 * dsh-cortex TUI state — codex-style committed + active model.
 *
 * Committed items (user messages, completed assistant turns, tool calls)
 * are immutable once written: ink's <Static> renders them once and never
 * redraws, so streaming deltas never trigger full-tree reflows.
 *
 * The active cell is one mutable string that the <Text> below <Static>
 * updates in place (ink clears and redraws only that line). This is how
 * codex's ratatui layout avoids flicker on high-frequency stream deltas.
 *
 * @module dsh-cortex/tui/store
 */

import type { CortexEvent, QuestionItem, QuestionAnswer, ApprovalRequest, ApprovalOutcome } from '../driver.ts'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { OverlayLine } from './transcript-overlay.tsx'
import { QuestionAlertTimer } from '../notify.ts'

/** One line in the transcript. Lines are rendered in a scroll viewport and
 * can carry optional expandable full content (reasoning or tool output). */
export interface CommittedLine {
  id: number
  /** Render kind controls color/prefix. */
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'separator'
  text: string
  /** Full text (reasoning body or tool output) when this row is collapsible. */
  fullText?: string | undefined
  /** Provider tool-call id for matching tool-start with its result. */
  callId?: string | undefined
  /** Whether the full text is expanded (tool output / verbose reasoning). */
  expanded?: boolean | undefined
}

/** Human's approval decision plus an optional rejection reason. */
export interface ApprovalDecision {
  outcome: ApprovalOutcome
  reason?: string
}

/** Complete TUI state. */
export interface CortexUiState {
  /** Immutable committed lines (rendered once via <Static>). */
  committed: CommittedLine[]
  /** The live streaming line (rendered in-place below Static). '' = idle. */
  activeText: string
  /** Color of the active line. */
  activeKind: 'reasoning' | 'text' | 'idle'
  /** Whether the agent is working. */
  busy: boolean
  /** Start timestamp (ms) of the running turn; null when idle. */
  turnStartedAt: number | null
  /** Duration (ms) of the last completed turn; null before the first turn. */
  lastTurnMs: number | null
  /** Current model display name. */
  model: string
  /** Current cwd display. */
  cwd: string
  /** Current sandbox/permission mode; shown in the status bar. */
  sandboxMode: string
  /** Current reasoning effort (e.g. low/medium/high/xhigh/max); '' when unset. */
  effort: string
  /** Whether reasoning summaries are expanded to full text (Ctrl+O). */
  showReasoning: boolean
  /** Active picker overlay (model catalog etc.); null when none. */
  picker: { title: string; items: { key: string; label: string; hint?: string }[] } | null
  /** Full-screen text viewer (e.g. /bash output); null when closed. */
  viewer: { title: string; lines: string[] } | null
  /** Interactive transcript overlay (Ctrl+O); null when closed. */
  transcriptOverlay: { lines: OverlayLine[] } | null
  /** Pending ask_user_question items from the agent; null when none. */
  questions: QuestionItem[] | null
  /** Pending sandbox-approval request; null when none. */
  approval: ApprovalRequest | null
}

const initialState: CortexUiState = {
  committed: [],
  activeText: '',
  activeKind: 'idle',
  busy: false,
  turnStartedAt: null,
  lastTurnMs: null,
  model: '',
  cwd: '',
  sandboxMode: '',
  effort: '',
  showReasoning: false,
  picker: null,
  viewer: null,
  transcriptOverlay: null,
  questions: null,
  approval: null,
}

/**
 * The UI state container. Mutations create new state objects and notify
 * subscribers; the React layer uses <Static> for committed items and a
 * single <Text> for the active line.
 */
export class CortexStore {
  private state: CortexUiState = { ...initialState }
  private listeners = new Set<() => void>()
  private nextId = 1

  /** Snapshot of current state. */
  snapshot(): CortexUiState {
    return this.state
  }

  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Coalesce high-frequency stream updates into one notification per frame
   *  (~16ms). Without this, every text/reasoning delta re-renders the whole
   *  ink tree and the committed <Static> rows flicker with duplicated text. */
  private notifyScheduled = false
  private scheduleNotify(): void {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    setTimeout(() => {
      this.notifyScheduled = false
      this.notify()
    }, 16)
  }

  /** Commit one line to the immutable transcript. */
  private commit(kind: CommittedLine['kind'], text: string, fullText?: string): void {
    const line: CommittedLine = { id: this.nextId++, kind, text, ...(fullText === undefined ? {} : { fullText }) }
    this.state = {
      ...this.state,
      committed: [...this.state.committed, line],
    }
    this.notify()
  }

  /** Update the active streaming line (or clear it). Coalesced notify: this
   *  is the hot path (every text/reasoning delta). */
  private setActive(text: string, kind: CortexUiState['activeKind']): void {
    this.state = { ...this.state, activeText: text, activeKind: kind }
    this.scheduleNotify()
  }

  /** Handle one driver event. */
  apply(event: CortexEvent): void {
    switch (event.kind) {
      case 'text-delta': {
        // Text started — commit any accumulated reasoning as a summary (or
        // full text when verbose reasoning is enabled).
        if (this.state.activeKind === 'reasoning') {
          this.commitReasoning(this.state.activeText)
          this.setActive('', 'idle')
        }
        const current = this.state.activeKind === 'text' ? this.state.activeText : ''
        this.setActive(current + event.text, 'text')
        break
      }
      case 'reasoning-delta': {
        // Accumulate reasoning into the active line only (streamed live, dim
        // yellow); it never lands in the committed transcript verbatim.
        if (this.state.activeKind === 'text') {
          // Text was streaming — commit it as assistant output first, then
          // start a fresh reasoning block (e.g. after a tool call).
          if (this.state.activeText !== '') {
            this.commit('assistant', this.state.activeText)
          }
          this.setActive('', 'idle')
          this.setActive(event.text, 'reasoning')
        } else if (this.state.activeKind === 'reasoning') {
          this.setActive(this.state.activeText + event.text, 'reasoning')
        } else {
          this.setActive(event.text, 'reasoning')
        }
        break
      }
      case 'tool-start': {
        // Commit any pending reasoning/assistant text, then open a collapsible
        // tool row (its output fills in via tool-result's fullText).
        if (this.state.activeText !== '') {
          if (this.state.activeKind === 'reasoning') {
            this.commitReasoning(this.state.activeText)
          } else {
            this.commit('assistant', this.state.activeText)
          }
          this.setActive('', 'idle')
        }
        const label = event.detail !== '' ? `${event.name}: ${event.detail}` : event.name
        const committed = this.state.committed.slice()
        committed.push({
          id: this.nextId++,
          kind: 'tool',
          text: label,
          callId: event.callId,
          fullText: '',
          expanded: false,
        })
        this.state = { ...this.state, committed }
        this.notify()
        break
      }
      case 'tool-result': {
        // Attach the full output to the matching tool row (by callId), so the
        // row can expand in place; show a brief inline status meanwhile.
        const committed = this.state.committed.slice()
        let matched = false
        if (event.callId !== undefined) {
          for (let i = committed.length - 1; i >= 0; i--) {
            const line = committed[i]
            if (line !== undefined && line.kind === 'tool' && line.callId === event.callId) {
              committed[i] = { ...line, fullText: event.detail, expanded: false }
              matched = true
              break
            }
          }
        }
        if (!matched) {
          for (let i = committed.length - 1; i >= 0; i--) {
            const line = committed[i]
            if (line !== undefined && line.kind === 'tool' && line.fullText === '') {
              committed[i] = { ...line, fullText: event.detail, expanded: false }
              break
            }
          }
        }
        this.state = { ...this.state, committed }
        this.notify()
        break
      }
      case 'turn-end': {
        // Commit the final assistant text. Pending reasoning (if the turn
        // ended without any text output) becomes a summary line.
        if (this.state.activeText !== '' && this.state.activeKind === 'reasoning') {
          this.commitReasoning(this.state.activeText)
          this.setActive('', 'idle')
        }
        if (this.state.activeText !== '') {
          this.commit('assistant', event.text !== '' ? event.text : this.state.activeText)
        } else if (event.text !== '') {
          this.commit('assistant', event.text)
        }
        this.setActive('', 'idle')
        this.settleTurn()
        break
      }
      case 'system': {
        // Slash-command feedback and other gray status lines.
        this.commit('system', event.message)
        break
      }
      case 'error': {
        this.commit('system', `error: ${event.message}`)
        this.setActive('', 'idle')
        this.settleTurn()
        break
      }
    }
  }

  /** Mark a user turn as started (busy on, commit the user line, start the clock). */
  beginTurn(text: string): void {
    // Insert a separator before a new user turn if there's already history.
    if (this.state.committed.length > 0) {
      this.commit('separator', '')
    }
    this.commit('user', text)
    this.state = {
      ...this.state,
      busy: true,
      turnStartedAt: Date.now(),
      lastTurnMs: null,
    }
    this.setActive('', 'idle')
  }

  /**
   * Settle a finished turn: record how long it took and clear busy.
   * The duration stays in `lastTurnMs` so the status bar can show it while idle.
   */
  private settleTurn(): void {
    const startedAt = this.state.turnStartedAt
    this.state = {
      ...this.state,
      busy: false,
      turnStartedAt: null,
      ...(startedAt === null ? {} : { lastTurnMs: Date.now() - startedAt }),
    }
    this.notify()
  }

  /** Set model/cwd/permission/effort display in the status bar. */
  setStatusBar(
    model: string,
    cwd: string,
    extras: { sandboxMode?: string; effort?: string } = {},
  ): void {
    this.state = {
      ...this.state,
      model,
      cwd,
      ...(extras.sandboxMode === undefined ? {} : { sandboxMode: extras.sandboxMode }),
      ...(extras.effort === undefined ? {} : { effort: extras.effort }),
    }
    this.notify()
  }

  /** Update the model display (after /model switch). */
  setModel(model: string): void {
    this.state = { ...this.state, model }
    this.notify()
  }

  /** Update the permission mode display (after /full, /restrict, /readonly). */
  setSandboxMode(mode: string): void {
    this.state = { ...this.state, sandboxMode: mode }
    this.notify()
  }

  /** Update the reasoning-effort display (after /effort). */
  setEffort(effort: string): void {
    this.state = { ...this.state, effort }
    this.notify()
  }

  /** Commit a completed reasoning block. Codex-aligned: the full text stays
   *  in the transcript rendered dim+italic (never folded to a stub), so a
   *  finished turn's thinking is always reviewable in place. */
  private commitReasoning(fullText: string): void {
    if (fullText === '') return
    this.commit('reasoning', fullText, fullText)
  }

  /** Toggle verbose reasoning display. Committed reasoning rows now always
   *  show their full text (codex-aligned); this flag only controls whether
   *  the LIVE streaming reasoning text is shown verbatim or as a counter. */
  toggleReasoning(): void {
    const show = !this.state.showReasoning
    this.state = { ...this.state, showReasoning: show }
    this.notify()
  }

  /** Toggle expand/collapse of a line by its committed id (tool output /
   *  reasoning body). */
  toggleLine(id: number): void {
    const committed = this.state.committed.map(line =>
      line.id === id && line.fullText !== undefined && line.fullText !== ''
        ? { ...line, expanded: line.expanded ? false : true }
        : line,
    )
    this.state = { ...this.state, committed }
    this.notify()
  }

  /** All tool rows in transcript order: {name, command, output} — for
   *  /bash which dumps every tool's full output outside the TUI. */
  toolOutputs(): { name: string; command: string; output: string; expanded: boolean }[] {
    return this.state.committed
      .filter(line => line.kind === 'tool')
      .map(line => ({
        name: line.text.split(':')[0] ?? 'tool',
        command: line.text,
        output: line.fullText ?? '',
        expanded: line.expanded === true,
      }))
  }

  /** Open a picker overlay (model catalog for /model). */
  openPicker(title: string, items: { key: string; label: string; hint?: string }[]): void {
    this.state = { ...this.state, picker: { title, items } }
    this.notify()
  }

  /** Close the picker overlay. */
  closePicker(): void {
    this.state = { ...this.state, picker: null }
    this.notify()
  }

  /** Open the full-screen text viewer. */
  openViewer(title: string, lines: string[]): void {
    this.state = { ...this.state, viewer: { title, lines } }
    this.notify()
  }

  /** Close the full-screen text viewer. */
  closeViewer(): void {
    this.state = { ...this.state, viewer: null }
    this.notify()
  }

  /** Open the interactive transcript overlay (Ctrl+O). Lines are derived
   *  live from `committed` on each render so Enter-expand updates show. */
  openTranscriptOverlay(): void {
    this.state = { ...this.state, transcriptOverlay: { lines: [] } }
    this.notify()
  }

  /** Current committed rows shaped for the transcript overlay. */
  overlayLines(): OverlayLine[] {
    return this.state.committed.map((line): OverlayLine => ({
      id: line.id,
      kind: line.kind,
      text: line.text,
      fullText: line.fullText,
      expanded: line.expanded === true,
    }))
  }

  /** Close the interactive transcript overlay. */
  closeTranscriptOverlay(): void {
    this.state = { ...this.state, transcriptOverlay: null }
    this.notify()
  }

  // ---- ask_user_question (terminal question cards) ----

  private questionResolve: ((answer: QuestionAnswer) => void) | null = null
  /** 提问提醒计时器：超时未答则发 macOS 系统通知（见 notify.ts）。 */
  private readonly questionAlert = new QuestionAlertTimer()

  /** Park agent questions and wait for the TUI's human answer. */
  askQuestions(items: QuestionItem[]): Promise<QuestionAnswer> {
    // Cancel any previous pending question (should not happen — agent waits).
    this.questionResolve = null
    this.state = { ...this.state, questions: items }
    this.notify()
    // 用户若已离开终端，超时后提醒；在终端前通常会立即作答，不会被打扰。
    this.questionAlert.start(items)
    return new Promise<QuestionAnswer>((resolve) => {
      this.questionResolve = resolve
    })
  }

  /** UI calls this when the human answered the parked questions. */
  answerQuestion(answer: QuestionAnswer): void {
    // 已作答 → 取消待触发的提醒。
    this.questionAlert.cancel()
    const resolve = this.questionResolve
    this.questionResolve = null
    this.state = { ...this.state, questions: null }
    this.notify()
    resolve?.(answer)
  }

  // ---- sandbox approval (single-call workspace-escape authorization) ----

  private approvalResolve: ((decision: ApprovalDecision) => void) | null = null

  /** Park one sandbox-approval request and wait for the human's decision. */
  askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.approvalResolve = null
    this.state = { ...this.state, approval: req }
    this.notify()
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolve = resolve
    })
  }

  /** UI calls this with the human's approval decision; reason rides a rejection. */
  answerApproval(outcome: ApprovalOutcome, reason?: string): void {
    const resolve = this.approvalResolve
    this.approvalResolve = null
    this.state = { ...this.state, approval: null }
    this.notify()
    resolve?.({ outcome, ...(reason === undefined ? {} : { reason }) })
  }

  /** Resolve the parked approval as cancelled (abort/quit paths). */
  cancelApproval(): void {
    this.answerApproval('cancelled')
  }

  /**
   * Load a resumed session's history into the committed transcript.
   * Rebuilds the full view from derived messages: user prompts, assistant
   * text, reasoning summaries, tool calls, and tool results — matching what
   * the live TUI shows, so a resumed session looks the same as the web view.
   */
  loadHistory(messages: readonly Message[]): void {
    const committed: CommittedLine[] = []
    for (const message of messages) {
      if (message.role === 'system') continue
      if (message.role === 'user') {
        if (message.source.kind === 'tool') {
          // Tool result message: surface its text content as a capped line.
          const text = textOf(message.content)
          if (text !== '') {
            committed.push({ id: this.nextId++, kind: 'system', text: `  → ${firstLines(text, 12)}` })
          }
          continue
        }
        if (message.source.kind !== 'user') continue
        committed.push({ id: this.nextId++, kind: 'user', text: textOf(message.content) })
        continue
      }
      if (message.role === 'assistant') {
        // Walk blocks in order: reasoning → summary, text → assistant line,
        // tool-call → tool line with command summary.
        for (const block of message.content) {
          const b = block as { type?: string; text?: string; name?: string; arguments?: string }
          if (b.type === 'reasoning' && typeof b.text === 'string' && b.text !== '') {
            committed.push({ id: this.nextId++, kind: 'reasoning', text: b.text, fullText: b.text })
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
            committed.push({ id: this.nextId++, kind: 'assistant', text: b.text })
          } else if ((b.type === 'tool-call' || b.type === 'tool_use') && typeof b.name === 'string') {
            const label = summarizeTool(b.name, b.arguments ?? '')
            committed.push({ id: this.nextId++, kind: 'tool', text: label })
          }
        }
        continue
      }
      const text = textOf(message.content)
      if (text !== '') {
        committed.push({ id: this.nextId++, kind: 'assistant', text: firstLines(text, 12) })
      }
    }
    this.state = { ...this.state, committed }
    this.notify()
  }
}

/** Concatenate text blocks of a message's content, recursing into nested
 * content (tool results nest text inside a tool-result block). */
function textOf(content: readonly unknown[]): string {
  const out: string[] = []
  collectText(content, out)
  return out.join('')
}

function collectText(blocks: readonly unknown[], out: string[]): void {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: string; content?: unknown[] }
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push(b.text)
    } else if (Array.isArray(b.content)) {
      collectText(b.content, out)
    }
  }
}

/** First n lines of a possibly long string. */
function firstLines(s: string, n: number): string {
  const lines = s.split('\n')
  return lines.length > n ? `${lines.slice(0, n).join('\n')}\n… (+${lines.length - n} lines)` : s
}

/** Build a compact label from tool name + arguments JSON. */
function summarizeTool(name: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    if (name === 'bash' && typeof args.command === 'string') return `bash: ${args.command.slice(0, 120)}`
    const first = Object.values(args)[0]
    return typeof first === 'string' ? `${name}: ${first.slice(0, 120)}` : name
  } catch {
    return name
  }
}
