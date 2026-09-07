/**
 * Ambient type shims for dsh-core APIs newer than the registry types this
 * project compiles against (registry peaks at 0.1.2-rc.1; the runtime fork
 * ships 0.1.3-alpha.1 with `agent/assistant-stream`).
 *
 * The runtime provides the event; only the compile-time surface is missing.
 * @module dsh-cortex/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** Minimal structural view of the assistant-stream frame the runtime emits. */
export type AssistantStreamFrameShim =
  | { readonly type: 'start' | 'end'; readonly attemptId?: unknown; readonly revision?: number; readonly outcome?: unknown }
  | { readonly type: 'chunk'; readonly attemptId?: unknown; readonly revision?: number; readonly index?: number; readonly time?: number; readonly chunk: StreamChunkShim }

/** Minimal structural view of stream chunks. */
export interface StreamChunkShim {
  readonly type:
    | 'block-start'
    | 'text-delta'
    | 'reasoning-delta'
    | 'tool-call-delta'
    | 'block-end'
    | 'usage'
    | 'finish'
  readonly index?: number
  readonly text?: string
  readonly name?: string
  readonly id?: string
  readonly argumentsDelta?: string
  readonly blockType?: string
  readonly block?: unknown
  readonly usage?: unknown
  readonly reason?: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Process-local assistant-stream publication (added in 0.1.3-alpha.1).
     * @param payload.agent - the agent whose attempt produced the frame.
     * @param payload.frame - one ordered start, chunk, or end publication.
     */
    'agent/assistant-stream'(this: { agent: Agent }, payload: {
      agent: Agent
      frame: AssistantStreamFrameShim
    }): void

    /**
     * user-questions waterfall (ask_user_question tool): return an answer to
     * claim the request, or call next() to delegate.
     */
    'user-questions/request'(
      this: { agent?: Agent },
      request: {
        questions: {
          id: string
          question: string
          detail?: string
          header?: string
          options?: { label: string; description?: string }[]
          multiSelect?: boolean
        }[]
        agent?: Agent
        signal?: AbortSignal
      },
      next: () => Promise<unknown>,
    ): Promise<unknown>
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface Session {
    /** Current log length (seq of next event). */
    readonly seq: SessionSeq
  }
}
