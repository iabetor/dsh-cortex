/**
 * dsh-cortex agent driver — owns the Agent lifecycle and turn loop, with a
 * UI-agnostic event stream. The TUI subscribes to these events; tests can too.
 *
 * @module dsh-cortex/driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from './types.d.ts'

/** One live UI-visible event during a turn. */
export type CortexEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'tool-start'; name: string; detail: string; callId?: string }
  | { kind: 'tool-result'; name: string; ok: boolean; detail: string; callId?: string }
  | { kind: 'turn-end'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'system'; message: string }

/** Subscriber for driver events. */
export type CortexListener = (event: CortexEvent) => void

/** One assistant text block aggregated from the durable session. */
function collectAssistantText(session: Session, firstSeq: number): string {
  let started = false
  let text = ''
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') break
  }
  return text
}

/** Resolve the live model selection from the agent-default-model service. */
function currentModelSelection(ctx: Context): ModelSelectionRef['current'] & {} {
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel === undefined) {
    throw new Error('dsh-cortex: agentDefaultModel service unavailable')
  }
  const selection = defaultModel.currentSelection()
  if (selection === undefined) {
    throw new Error('dsh-cortex: no default model selection configured')
  }
  return selection
}

/** One question the agent asks the user (ask_user_question tool). */
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** Answer payload returned to the agent. */
export interface QuestionAnswer {
  answers: { id: string; selected: string[]; custom?: string }[]
}

/**
 * Install the cortex terminal answerer on the agent's scoped ctx: claims the
 * user-questions/request waterfall, hands the questions to the TUI (ask),
 * and returns the human's answer. Delegates (next) when the UI declines.
 */
export function installQuestionAnswerer(
  agentCtx: Context,
  ask: (questions: QuestionItem[]) => Promise<QuestionAnswer>,
): void {
  void (agentCtx.on as (name: string, handler: (...args: unknown[]) => unknown) => void)(
    'user-questions/request',
    async (request: unknown, next: unknown) => {
      const req = request as { questions?: QuestionItem[] }
      const delegate = next as (() => Promise<unknown>) | undefined
      if (req.questions === undefined || req.questions.length === 0) {
        if (delegate !== undefined) return delegate()
        return undefined
      }
      try {
        return await ask(req.questions)
      } catch {
        if (delegate !== undefined) return delegate()
        return undefined
      }
    },
  )
}

/** Compose the agent's scoped world with the pinned model selection. */
function makeSetup(selection: ModelSelectionRef['current']): (agentCtx: Context) => void {
  return (agentCtx) => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
}

// ---- sandbox approval (single-call workspace-escape authorization) ----

/** A sandbox-escalation decision the harness asks the human to make. */
export interface ApprovalRequest {
  /** Agent requesting the escalation. */
  readonly agent: unknown
  /** Tool whose operation requires the decision (write/edit/bash). */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: string
  /** Human-readable reason (e.g. "escalate sandbox to danger-full-access: …"). */
  readonly reason?: string
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

/** The closed outcome vocabulary the approval answerer must return. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** How cortex asks the human for one approval decision. */
export type AskApproval = (req: ApprovalRequest) => Promise<ApprovalOutcome>

/**
 * Install the cortex terminal approval answerer on the agent's scoped ctx:
 * claims the approval/request waterfall (agent-scoped, same mechanism as
 * user-questions/request), hands the request to the TUI, and returns the
 * closed outcome. Delegates (next) when the UI declines.
 */
export function installApprovalAnswerer(
  agentCtx: Context,
  ask: AskApproval,
): void {
  void (agentCtx.on as (name: string, handler: (...args: unknown[]) => unknown) => void)(
    'approval/request',
    async (request: unknown, next: unknown) => {
      const req = request as ApprovalRequest
      const delegate = next as (() => Promise<unknown>) | undefined
      if (req === null || typeof req !== 'object' || typeof req.toolName !== 'string') {
        if (delegate !== undefined) return delegate()
        return undefined
      }
      try {
        return await ask(req)
      } catch {
        if (delegate !== undefined) return delegate()
        return undefined
      }
    },
  )
}

/**
 * Create a fresh Agent/session, or resume one by persisted id.
 *
 * When a new session is created, the current working directory is registered
 * as a durable workspace (codex-style cwd-as-group) and the session is
 * attached to it, so the directory appears in dsh's workspace list and the
 * session is grouped under it.
 *
 * @param ctx - plugin context with agents + agentDefaultModel + workspaceRegistry.
 * @param resumeSessionId - optional persisted session id to resume.
 */
export async function openAgent(
  ctx: Context,
  resumeSessionId?: string,
  askQuestion?: (questions: QuestionItem[]) => Promise<QuestionAnswer>,
): Promise<Agent> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  if (agents === undefined) {
    throw new Error('dsh-cortex: agents service unavailable')
  }
  const selection = currentModelSelection(ctx)
  const setup = makeSetup(selection)
  const agentOptions = {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
  const handle = resumeSessionId === undefined
    ? await agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    : await agents.resume({
      resumeSessionId: brandString<SessionId>(resumeSessionId),
      agentOptions,
      setup,
    })
  await handle.agent.whenIdle()
  // Install the terminal question answerer on the published agent scope so
  // ask_user_question waterfalls reach the TUI.
  if (askQuestion !== undefined) {
    installQuestionAnswerer(handle.agent.ctx, askQuestion)
  }
  // NOTE: workspace attach now happens lazily — only after the session has
  // produced real content (first completed turn), so empty throwaway sessions
  // (started but never used) never show up as blank workspace rows.
  return handle.agent
}

/** Register cwd as a workspace and attach the session to it (idempotent).
 * Exported so the runner can attach lazily after the first real turn. */
export async function attachToWorkspace(ctx: Context, sessionId: SessionId): Promise<void> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    process.stderr.write('dsh-cortex: workspaceRegistry unavailable — session will not be grouped.\n')
    return
  }
  const cwd = process.cwd()
  try {
    const workspace = await registry.create(cwd)
    await workspace.attachSession(sessionId)
  } catch (error: unknown) {
    process.stderr.write(`dsh-cortex: workspace attach failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Run one user turn to quiescence, streaming events to listeners.
 * @param ctx - plugin context (for the assistant-stream subscription).
 * @param agent - the live agent driving the session.
 * @param text - the user's message.
 * @param emit - listener receiving live events.
 */
export async function runTurn(
  ctx: Context,
  agent: Agent,
  text: string,
  emit: CortexListener,
): Promise<void> {
  const firstSeq = agent.session.seq
  // Track tool-call ids we've already announced, so one bash call doesn't
  // produce a dozen "⏳ bash" lines.
  const seenToolIds = new Set<string>()
  // Accumulate arguments per tool-call id so we can show the bash command.
  const toolArgs = new Map<string, string>()
  // Live assistant stream: text/reasoning deltas + tool-call markers.
  // Subscribe on the agent's scoped ctx (not the plugin ctx): the agent's
  // dispatch emits through its own scope, so only agent-scoped listeners
  // receive the events.
  const disposer = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'text-delta':
        emit({ kind: 'text-delta', text: chunk.text ?? '' })
        return
      case 'reasoning-delta':
        if ((chunk.text ?? '') !== '') emit({ kind: 'reasoning-delta', text: chunk.text ?? '' })
        return
      case 'tool-call-delta': {
        // Accumulate arguments per tool-call id; emit tool-start once when
        // the name arrives. The full command string is available at block-end.
        const toolId = chunk.id ?? ''
        if (toolId !== '') {
          if (chunk.name !== undefined && !seenToolIds.has(toolId)) {
            seenToolIds.add(toolId)
            toolArgs.set(toolId, chunk.argumentsDelta ?? '')
          } else if (toolArgs.has(toolId)) {
            toolArgs.set(toolId, (toolArgs.get(toolId) ?? '') + (chunk.argumentsDelta ?? ''))
          }
        }
        return
      }
      case 'block-end':
        // Tool-start cards come from the session poll (authoritative, one per
        // call id); the stream's block-end only confirms block completion.
        return
      case 'block-start':
      case 'usage':
      case 'finish':
        return
    }
  })
  // Track how far we've scanned session events so tool calls surface in
  // real-time (not just at turn-end).
  let scannedSeq = firstSeq
  const pollSession = (): void => {
    const length = agent.session.seq
    for (let seq = scannedSeq; seq < length; seq++) {
      const event = agent.session.eventAt(SessionSeq(seq))
      if (event === undefined) continue
      if (event.type === 'tool/call') {
        const data = event.data as { name: string; arguments: string; callId?: string }
        const summary = formatToolArgs(data.name, data.arguments)
        emit({ kind: 'tool-start', name: data.name, detail: summary, callId: data.callId })
      } else if (event.type === 'tool/result') {
        const resultText = formatToolResult(event.data)
        // tool/result's data has no name/callId at top level; find the callId
        // from its message.source.callId, and the name from the prior call.
        const data = event.data as { message?: { source?: { callId?: string } } }
        const callId = data.message?.source?.callId
        let toolName = 'tool'
        for (let s = seq - 1; s >= scannedSeq; s--) {
          const prev = agent.session.eventAt(SessionSeq(s))
          if (prev !== undefined && prev.type === 'tool/call') {
            toolName = (prev.data as { name: string }).name
            break
          }
        }
        emit({ kind: 'tool-result', name: toolName, ok: true, detail: resultText, callId })
      }
    }
    scannedSeq = length
  }
  const pollTimer = setInterval(pollSession, 200)
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    clearInterval(pollTimer)
    disposer()
  }
  // Final scan to catch any events that arrived after the last poll.
  pollSession()
  const final = collectAssistantText(agent.session, firstSeq)
  emit({ kind: 'turn-end', text: final })
}

/**
 * Steer a message into the agent's CURRENT running turn (interrupt-style):
 * the message is consumed at the nearest step boundary, not queued for the
 * next turn. Mirrors the web session-controller's `mode: 'steer'` path.
 * Only meaningful while the agent is running; when idle it behaves like a
 * normal follow-up (an idle driver starts a turn on steer).
 */
export async function steerTurn(
  ctx: Context,
  agent: Agent,
  text: string,
  emit: CortexListener,
): Promise<void> {
  const firstSeq = agent.session.seq
  const disposer = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'text-delta':
        emit({ kind: 'text-delta', text: chunk.text ?? '' })
        return
      case 'reasoning-delta':
        if ((chunk.text ?? '') !== '') emit({ kind: 'reasoning-delta', text: chunk.text ?? '' })
        return
      case 'block-start':
      case 'block-end':
      case 'usage':
      case 'finish':
        return
    }
  })
  try {
    agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    disposer()
  }
  const final = collectAssistantText(agent.session, firstSeq)
  emit({ kind: 'turn-end', text: final })
}

/** Format tool arguments JSON into a short display string (e.g. bash command). */
function formatToolArgs(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    if (toolName === 'bash' || toolName === 'Bash') {
      const cmd = args.command ?? args.cmd ?? ''
      return typeof cmd === 'string' ? cmd.slice(0, 120) : String(cmd).slice(0, 120)
    }
    if (toolName === 'ask_user_question') {
      // Show the actual questions instead of "[object Object]".
      const questions = args.questions
      if (Array.isArray(questions)) {
        const texts = questions.map((q) => {
          const item = q as { question?: unknown; header?: unknown }
          const text = typeof item.question === 'string'
            ? item.question
            : typeof item.header === 'string' ? item.header : ''
          return text
        }).filter((t): t is string => t !== '')
        if (texts.length > 0) {
          const joined = texts.join(' | ')
          return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined
        }
      }
      return 'ask the user'
    }
    // Generic: show first value.
    const firstVal = Object.values(args)[0]
    if (typeof firstVal === 'string') return firstVal.slice(0, 120)
    if (Array.isArray(firstVal)) return `[${firstVal.length} items]`
    return firstVal === undefined ? '' : String(firstVal).slice(0, 120)
  } catch {
    return argsJson.slice(0, 120)
  }
}

/** Format a tool result into a short summary for display. */
/** Recursively collect text from a content block tree (tool results nest:
 * tool-result → content[] → text). */
function collectTextFromBlocks(blocks: readonly unknown[], out: string[]): void {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: string; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push(b.text)
      continue
    }
    if (Array.isArray(b.content)) collectTextFromBlocks(b.content, out)
  }
}

function formatToolResult(data: unknown): string {
  const result = data as { message?: { content?: unknown[] }; error?: { name?: string; code?: string } }
  if (result.error !== undefined) {
    return `error: ${result.error.code ?? result.error.name ?? 'unknown'}`
  }
  const content = result.message?.content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  collectTextFromBlocks(content, texts)
  const joined = texts.join('\n').trim()
  if (joined === '') return ''
  // Tool cards show the full output when expanded; keep a generous cap so a
  // pathological output (e.g. cat of a huge file) cannot freeze the TUI.
  return joined.slice(0, 20000)
}

/** Flush the agent's session to durable storage (no-op when absent). */
export async function flushSession(ctx: Context, agent: Agent): Promise<void> {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) await sessions.flush(agent.session)
}

/** Cancel the agent's active turn (Ctrl+C). */
export function cancelTurn(agent: Agent): void {
  agent.cancel({ kind: 'user' }, { keepInbox: true })
}

/** Sandbox modes cortex can switch to at runtime. */
export type CortexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Switch the session's sandbox mode for subsequent confined calls (bash/fs).
 * Persisted as a `sandbox/mode` event on the session log — survives restart.
 * @param agent - the live agent whose session to switch.
 * @param mode - target sandbox mode.
 */
export function switchSandboxMode(agent: Agent, mode: CortexSandboxMode): void {
  setSandboxMode(agent.session, mode)
}

/** Read the session's current sandbox override (last sandbox/mode event). */
export function currentSandboxMode(agent: Agent): CortexSandboxMode {
  const events = agent.session.snapshotEvents()
  let mode: CortexSandboxMode = 'workspace-write'
  for (const event of events) {
    if (event.type === 'sandbox/mode') {
      const m = (event.data as { mode?: string }).mode
      if (m === 'read-only' || m === 'workspace-write' || m === 'danger-full-access') {
        mode = m
      }
    }
  }
  return mode
}

/**
 * List available models for the agent's current provider, from the LLM catalog.
 * @param ctx - plugin context with the llm service.
 * @param agent - the agent whose provider to query.
 * @returns model ids and display names.
 */
export async function listModels(ctx: Context, agent: Agent): Promise<readonly { id: string; name: string }[]> {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  const provider = agent.options.provider ?? ''
  if (provider === '') return []
  try {
    const models = await llm.listModels(provider)
    return models.map(m => ({ id: m.id, name: m.name ?? m.id }))
  } catch {
    return []
  }
}

/**
 * Switch the agent's model (and optionally reasoning effort) for the next
 * request. Mirrors the web session-controller's selectModel path:
 * resolveCallConfig validates, then installModelSelection installs.
 * @param ctx - plugin context.
 * @param agent - the agent to reconfigure.
 * @param model - target model id.
 * @param reasoningEffort - optional effort override.
 * @returns the resolved selection that was installed.
 */
export async function switchModel(
  ctx: Context,
  agent: Agent,
  model: string,
  reasoningEffort?: string,
): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('dsh-cortex: llm service unavailable for model switch')
  }
  const provider = agent.options.provider ?? ''
  const resolved = await llm.resolveCallConfig({
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never }),
  })
  const selection: ModelSelectionRef = {
    current: { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) },
    assembled: undefined,
  }
  installModelSelection(agent.ctx, selection)
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  }
}
