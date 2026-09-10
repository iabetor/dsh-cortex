/**
 * dsh-cortex — interactive codex-style terminal driver for DeepSeek Harness.
 *
 * Mounts the runner that reads startup values from `cortexStartup` (see
 * ./startup.ts) and drives one persistent Agent/Session:
 *
 *  - one-shot mode: `dsh --profile cortex "<task>"` runs the task, prints the
 *    answer, and exits.
 *  - REPL mode (no task): a full-screen ink TUI with a scrolling conversation
 *    pane, detailed tool log, and a bottom input; `/quit` exits, Escape
 *    cancels the running turn.
 *
 * Session lifecycle (codex-style, grouped by cwd):
 *  - default: start a NEW session bound to the current working directory
 *  - `--resume`: open a picker of this directory's recent sessions
 *  - `--resume <id>`: resume a specific session id
 *  - `--last`: resume the most recent session in this directory
 *
 * @module dsh-cortex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { openAgent, runTurn, steerTurn, flushSession, listModels, switchModel, switchSandboxMode, currentSandboxMode, currentReasoningEffort, attachToWorkspace, installQuestionAnswerer, installApprovalAnswerer, cancelTurn } from './driver.ts'
import type { QuestionItem, QuestionAnswer, ApprovalRequest, ApprovalOutcome } from './driver.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CortexEvent } from './driver.ts'
import { CortexStore } from './tui/store.ts'
import { InputQueue } from './input-queue.ts'
import { listSessionsForCwd } from './sessions.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-cortex'

/** Plugin config: the startup values resolved from the injected provider. */
export interface Config {
  /** Optional one-shot task; when absent the runner enters the REPL. */
  task: string
  /** Resume a specific persisted session id ('' = none; REPL mode). */
  resume: string
  /** Resume the most recent session in this directory. */
  last: boolean
  /** Open the resume picker. */
  pick: boolean
  /**
   * Run inline instead of the alternate screen, keeping TUI rows in the normal
   * scrollback after exit (--no-alt-screen; default false = use alt screen).
   */
  noAltScreen: boolean
}

export const Config: z<Config> = z.object({
  task: z.string().default(''),
  resume: z.string().default(''),
  last: z.boolean().default(false),
  pick: z.boolean().default(false),
  noAltScreen: z.boolean().default(false),
})

/** Process-facing effects of one run: output streams plus exit request. */
interface CortexIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: CortexIo['stdout']; stderr: CortexIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Mount the cortex runner. One-shot when a task was supplied; otherwise the
 * interactive REPL.
 * @param ctx - plugin context carrying core services.
 * @param config - validated startup values.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  const io: CortexIo = {
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit: exit === undefined ? (code) => { process.exitCode = code } : exit,
  }
  void (async () => {
    await ctx.get('loader')?.await()
    if (config.task !== undefined && config.task !== '') {
      await runOneShot(ctx, config.task, io)
      io.exit(0)
      return
    }
    await runRepl(ctx, io, {
      resume: config.resume === '' ? undefined : config.resume,
      last: config.last === true,
      pick: config.pick === true,
      noAltScreen: config.noAltScreen === true,
    })
  })().catch((error: unknown) => {
    io.stderr.write(`dsh-cortex: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}

/** One-shot driver: run a task and print the durable final answer. */
async function runOneShot(ctx: Context, task: string, io: CortexIo): Promise<void> {
  const agent = await openAgent(ctx)
  let finalText = ''
  const emit: (event: CortexEvent) => void = (event) => {
    if (event.kind === 'turn-end') finalText = event.text
  }
  await runTurn(ctx, agent, task, emit)
  await flushSession(ctx, agent)
  // One-shot tasks are exactly the case that should be grouped: the cwd is a
  // real workspace and the session has produced content by now. The lazy REPL
  // attach below never runs in this path.
  await attachToWorkspace(ctx, agent.session.id).catch(() => { /* non-fatal */ })
  io.stdout.write(finalText + '\n')
}

/** How the REPL chooses its session. */
interface ReplSessionChoice {
  resume?: string | undefined
  last?: boolean
  pick?: boolean
  /** Run inline instead of the alternate screen (--no-alt-screen). */
  noAltScreen?: boolean
}

/**
 * Interactive REPL with an ink full-screen UI.
 *
 * Two-phase startup so the session is created only after the user's choice:
 *   1. picker phase (only when `--resume` without id and sessions exist):
 *      render the resume list, await a selection, unmount.
 *   2. chat phase: open the agent (new session or resumed id) and render the
 *      main conversation TUI.
 *
 * @param ctx - plugin context.
 * @param io - process effects.
 * @param choice - how to select the session (new / resume id / last / pick).
 */
async function runRepl(ctx: Context, io: CortexIo, choice: ReplSessionChoice): Promise<void> {
  const { default: React } = await import('react')
  const { render } = await import('ink')
  const { CortexApp } = await import('./tui/app.tsx')
  const { ResumePicker } = await import('./tui/picker.tsx')

  // Phase 1: resolve the session id (picker / last / explicit).
  const cwd = process.cwd()
  let resumeId: string | undefined = choice.resume
  if (resumeId === undefined && (choice.last === true || choice.pick === true)) {
    const sessions = listSessionsForCwd(cwd)
    if (choice.last === true) {
      resumeId = sessions[0]?.id
      if (resumeId === undefined) {
        io.stderr.write('dsh-cortex: no sessions in this directory; starting a new one.\n')
      }
    } else if (choice.pick === true && sessions.length > 0) {
      resumeId = await new Promise<string | undefined>((resolve) => {
        const instance = render(React.createElement(ResumePicker, {
          sessions,
          cwd,
          onPick: (result) => {
            instance.unmount()
            resolve(result)
          },
        }), { alternateScreen: choice.noAltScreen !== true })
      })
    }
  }

  // Phase 2: open the agent and render the chat TUI.
  const agent: Agent = await openAgent(ctx, resumeId)
  const store = new CortexStore()
  const emit = (event: CortexEvent): void => store.apply(event)

  // Terminal question UI: when the agent calls ask_user_question, park the
  // questions in the store, render them in the TUI, and resolve with the
  // human's answer (options picked or free text typed).
  installQuestionAnswerer(agent.ctx, async (questions: QuestionItem[]): Promise<QuestionAnswer> => {
    return store.askQuestions(questions)
  })

  // Sandbox-approval UI: when a confined tool (write/edit/bash) wants to act
  // outside the workspace sandbox, the harness raises an approval/request on
  // the agent scope. Ask the human in the TUI; y = allow and remember this
  // tool+reason for the rest of the session, n = reject (optional reason is
  // fed back to the model via followup), q/Esc = cancel.
  const approvalAllowlist = new Set<string>()
  const approvalKey = (req: ApprovalRequest): string => `${req.toolName}\u0000${req.reason ?? ''}`
  installApprovalAnswerer(agent.ctx, async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    const key = approvalKey(req)
    if (approvalAllowlist.has(key)) return 'allowed-once'
    const decision = await store.askApproval(req)
    if (decision.outcome === 'allowed-once') {
      approvalAllowlist.add(key)
      return 'allowed-once'
    }
    if (decision.outcome === 'rejected' && decision.reason !== undefined) {
      // Feed the human's rejection reason back to the model.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: `用户拒绝了这次工作区外操作: ${decision.reason}` }],
        source: { kind: 'plugin', plugin: 'cortex' },
      }))
    }
    return decision.outcome
  })

  // Set the status bar (model + cwd + permission + effort).
  store.setStatusBar(agent.options.model ?? 'unknown', cwd, {
    sandboxMode: currentSandboxMode(agent),
    effort: currentReasoningEffort(ctx) ?? '',
  })

  // When resuming, load the persisted conversation into the committed transcript.
  if (resumeId !== undefined) {
    const history = agent.session.deriveMessages()
    store.loadHistory(history)
  }

  let exiting = false
  /**
   * The mounted ink app, captured so exit can unmount it first. ink only emits
   * the "leave alternate screen" escape during unmount, and this runner exits
   * with process.exit, which would otherwise strand the terminal in the
   * alternate buffer (the vim-style page would never restore).
   */
  let tuiInstance: { unmount: () => void } | null = null
  const doExit = (): void => {
    if (exiting) return
    exiting = true
    // Restore the primary screen buffer before the process ends.
    try { tuiInstance?.unmount() } catch { /* teardown must not block exit */ }
    // Safety net: if this session already carries user input but was never
    // bound (e.g. an interrupted turn before the attach landed), bind it now
    // so quitting never leaves a used session ungrouped. Empty sessions are
    // skipped, so a stray launch still leaves no blank workspace row.
    if (!attachedWorkspace && store.snapshot().committed.some(line => line.kind === 'user')) {
      attachOnce()
    }
    const flush = flushSession(ctx, agent)
    const timer = setTimeout(() => { io.exit(0) }, 3000)
    void flush
      .catch(() => { /* flush failure must not block exit */ })
      // Wait for the lazy workspace attach so the session is grouped before
      // the process ends (previously it could be dropped on a quick /quit).
      .then(async () => { await pendingAttach })
      .catch(() => { /* attach failure must not block exit */ })
      .finally(() => { clearTimeout(timer); io.exit(0) })
  }

  /** Cancel the running turn (Escape); no-op when idle. Keeps queued inputs. */
  const onCancel = (): void => {
    if (!isBusy()) return
    cancelTurn(agent)
    store.apply({ kind: 'system', message: '⏹ 已取消当前回合' })
  }

  // Input model (codex-aligned): with a typed draft,
  //   Enter = steer into the running turn when busy, direct send when idle
  //   Tab   = queue for the next turn when busy, direct send when idle
  const pendingQueue = new InputQueue()
  let turnRunning = false

  const isBusy = (): boolean => store.snapshot().busy || turnRunning

  /** Queue one line; auto-send queued lines one at a time after each turn.
   *  The queue is mirrored into UI state so it renders next to the input box
   *  instead of scrolling away in the transcript. */
  const queueInput = (text: string): void => {
    const { startNow } = pendingQueue.push(text, isBusy())
    store.setQueuedInputs(pendingQueue.list())
    if (startNow !== undefined) startTurn(startNow)
  }

  /** Enter (submit): idle → new turn; busy → steer into the running turn.
   *  Codex-aligned: Enter is the steer key. */
  const onSubmit = (text: string): void => {
    if (isBusy()) {
      store.beginTurn(text)
      store.apply({ kind: 'system', message: `⚡ 插入到当前回合: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` })
      void steerTurn(ctx, agent, text, emit)
        .catch((error: unknown) => emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
      return
    }
    startTurn(text)
  }

  /** Tab: idle → new turn (same as Enter); busy → queue for the next turn.
   *  Codex-aligned: Tab is the queue key. */
  const onSteer = (text: string): void => {
    if (isBusy()) {
      queueInput(text)
      return
    }
    startTurn(text)
  }

  let attachedWorkspace = false
  /** Pending lazy attach; awaited on exit so the binding is never lost. */
  let pendingAttach: Promise<void> | null = null
  /**
   * Bind the session to its cwd workspace on the FIRST real user input (not
   * after the turn finishes): a session the user actually typed into belongs
   * in the group even if the turn is cancelled or the process dies midway.
   * Empty sessions — started and abandoned with no input — still never attach,
   * so they cannot leave a blank workspace row.
   */
  const attachOnce = (): void => {
    if (attachedWorkspace || resumeId !== undefined) return
    attachedWorkspace = true
    pendingAttach = attachToWorkspace(ctx, agent.session.id).catch(() => { /* non-fatal */ })
  }

  const startTurn = (text: string): void => {
    turnRunning = true
    attachOnce()
    store.beginTurn(text)
    void runTurn(ctx, agent, text, emit)
      .catch((error: unknown) => emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        turnRunning = false
        // A settled turn releases exactly one queued line, which then starts
        // its own turn; that turn's finally drains the next one, and so on.
        const next = pendingQueue.releaseNext()
        store.setQueuedInputs(pendingQueue.list())
        if (next !== undefined) startTurn(next)
      })
  }

  // Slash command feedback helper (shared by onCommand and picker results).
  const note = (message: string): void => {
    store.apply({ kind: 'system', message })
  }

  // Slash command handler: /model, /effort, etc.
  const onCommand = (cmd: string, args: string): void => {
    switch (cmd) {
      case 'model': {
        // No args → interactive picker; args → switch by index / id / fuzzy.
        void (async () => {
          if (args === '') {
            const current = agent.options.model ?? 'unknown'
            const models = await listModels(ctx, agent)
            if (models.length === 0) {
              note(`/model 可用模型: none (provider: ${agent.options.provider ?? 'unknown'})`)
              return
            }
            store.openPicker(`/model — 选择模型 (当前: ${current})`, models.map(m => ({
              key: m.id,
              label: m.id,
              ...(m.id === current ? { hint: 'current' } : {}),
            })))
            return
          }
          const arg = args.trim()
          const models = await listModels(ctx, agent)
          let target: string | undefined
          if (/^\d+$/.test(arg)) {
            const picked = models[Number(arg)]
            if (picked === undefined) {
              note(`/model: 编号 ${arg} 超出范围 (0-${models.length - 1})`)
              return
            }
            target = picked.id
          } else {
            const exact = models.find(m => m.id === arg)
            if (exact !== undefined) {
              target = exact.id
            } else {
              const matches = models.filter(m =>
                m.id.includes(arg) || (m.name ?? '').includes(arg),
              )
              if (matches.length === 1) {
                target = matches[0]?.id
              } else if (matches.length > 1) {
                note(`/model "${arg}" 匹配多个: ${matches.map(m => m.id).join(', ')} — 用编号或完整 id`)
                return
              } else {
                note(`/model: 未找到匹配 "${arg}" 的模型 (用 /model 看列表)`)
                return
              }
            }
          }
          if (target === undefined) {
            note('/model: 无法解析目标模型')
            return
          }
          try {
            const resolved = await switchModel(ctx, agent, target)
            note(`已切换到 ${resolved.model}`)
            store.setModel(resolved.model)
          } catch (error) {
            note(`/model 切换失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
        break
      }
      case 'effort': {
        // Show the current effort, or switch when a level is given.
        const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
        void (async () => {
          if (args === '') {
            note(`/effort <${levels.join('|')}>: current = ${agent.options.reasoningEffort ?? 'default'}`)
            return
          }
          const level = args.trim()
          if (!(levels as readonly string[]).includes(level)) {
            note(`/effort: unknown level "${level}" (expected one of: ${levels.join(', ')})`)
            return
          }
          const model = agent.options.model ?? ''
          if (model === '') {
            note('/effort: no model selected to apply effort to')
            return
          }
          try {
            const resolved = await switchModel(ctx, agent, model, level)
            note(`已切换 effort 到 ${resolved.reasoningEffort ?? level}`)
            store.setEffort(resolved.reasoningEffort ?? level)
          } catch (error) {
            note(`/effort 切换失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
        break
      }
      case 'image': {
        // Send an image file path to the agent; the agent uses its read_image
        // tool to read and analyze the image (terminal TUIs can't paste image
        // bytes directly, so we route through the tool like codex/claude CLI).
        if (args.trim() === '') {
          note('/image <path>: 让 agent 读取并分析图片文件 (PNG/JPG/WebP/GIF)')
          return
        }
        const imgPath = args.trim()
        note(`📷 图片: ${imgPath}`)
        // Send as a user turn with an instruction to read the image.
        const imgText = `Please use the read_image tool to read the image at "${imgPath}" and analyze it.`
        queueInput(imgText)
        break
      }
      case 'full': {
        // Escalate this session to danger-full-access (no approval prompts,
        // no sandbox) for subsequent bash/fs calls.
        switchSandboxMode(agent, 'danger-full-access')
        note('⚠️ 已切换到完全权限 (danger-full-access) — 后续 bash/文件操作不再受限')
        store.setSandboxMode('danger-full-access')
        break
      }
      case 'restrict': {
        // Drop back to the safe workspace-write sandbox.
        switchSandboxMode(agent, 'workspace-write')
        note('已切换回 workspace-write（仅当前工作区可写）')
        store.setSandboxMode('workspace-write')
        break
      }
      case 'readonly': {
        // Read-only: bash/fs can read anywhere but cannot write.
        switchSandboxMode(agent, 'read-only')
        note('已切换为 read-only（只读，禁止任何写入）')
        store.setSandboxMode('read-only')
        break
      }
      case 'perm': {
        const mode = currentSandboxMode(agent)
        note(`当前 sandbox: ${mode}`)
        const hint = mode === 'danger-full-access'
          ? '(用 /restrict 降级, /readonly 只读)'
          : mode === 'read-only'
            ? '(用 /full 提升, /restrict 可写)'
            : '(用 /full 完全权限, /readonly 只读)'
        note(`  提示: ${hint}`)
        break
      }
      case 'bash': {
        // Show every tool call's full output in an in-TUI pager so the user
        // can read long bash results right here (↑/↓/PgUp/PgDn scroll, q
        // closes) without leaving the session.
        const tools = store.toolOutputs()
        if (tools.length === 0) {
          note('/bash: 当前会话还没有工具调用')
          break
        }
        const filter = args.trim()
        const selected = filter === ''
          ? tools
          : tools.filter(t => t.command.includes(filter))
        if (selected.length === 0) {
          note(`/bash: 没有匹配 "${filter}" 的工具调用`)
          break
        }
        const lines: string[] = []
        selected.forEach((t, i) => {
          lines.push(`── [${i + 1}] ${t.command}${t.output === '' ? ' (无输出)' : ''}`)
          if (t.output !== '') lines.push(...t.output.split('\n'))
          lines.push('')
        })
        store.openViewer(`bash 输出 (${selected.length} 条${filter !== '' ? `, 过滤 "${filter}"` : ''})`, lines)
        break
      }
      case 'help': {
        // Full-screen reference panel (commands + keybindings), scrollable.
        store.openHelp()
        break
      }
      default: {
        note(`unknown command: /${cmd}`)
      }
    }
  }

  const onPickResult = (key: string | undefined): void => {
    if (key === undefined) {
      note('/model 已取消')
      return
    }
    void (async () => {
      try {
        const resolved = await switchModel(ctx, agent, key)
        note(`已切换到 ${resolved.model}`)
        store.setModel(resolved.model)
      } catch (error) {
        note(`/model 切换失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  // Alternate screen (like vim/codex/claude): entering swaps to a fresh
  // terminal page and leaving restores whatever was on screen before. Pass
  // --no-alt-screen to stay inline and keep the rows in the normal scrollback.
  tuiInstance = render(React.createElement(CortexApp, {
    store,
    onSubmit,
    onSteer,
    onCommand,
    onPickResult,
    onCancel,
    onExit: doExit,
  }), { alternateScreen: choice.noAltScreen !== true })
}
