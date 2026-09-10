/**
 * FIFO input queue for cortex's REPL: lines typed while a turn is running are
 * held here and released one at a time as each turn settles.
 *
 * The queue is deliberately transport-free (no store, no agent): it owns only
 * ordering and the "exactly one next item" rule, so the drain behavior — the
 * part users actually notice — can be unit-tested without a live agent.
 *
 * @module dsh-cortex/input-queue
 */

/** Result of pushing one line: what (if anything) the caller must send now. */
export interface InputQueuePush {
  /**
   * Line to start a turn with immediately, or `undefined` when the queue is
   * simply holding the item for a later drain.
   */
  readonly startNow: string | undefined
}

/**
 * One FIFO of pending lines plus the release rule.
 *
 * The caller decides "busy" (it knows about the live turn and the store); the
 * queue only guarantees that a line pushed while idle is handed straight back
 * and that {@link releaseNext} yields at most one line per settled turn.
 */
export class InputQueue {
  private readonly items: string[] = []

  /** Current contents, oldest first (a copy, so callers cannot mutate it). */
  list(): string[] {
    return [...this.items]
  }

  /** Whether any line is still waiting. */
  get size(): number {
    return this.items.length
  }

  /**
   * Add one line.
   * @param text - the line to enqueue.
   * @param busy - whether a turn is currently running.
   * @returns the line to start immediately when nothing was running, else
   *   `undefined` (the line stays queued).
   */
  push(text: string, busy: boolean): InputQueuePush {
    this.items.push(text)
    if (busy) return { startNow: undefined }
    // Idle: never hold input back — hand the oldest line straight to the caller.
    return { startNow: this.items.shift() }
  }

  /**
   * Take the next line to run, called once per settled turn.
   * @returns the oldest queued line, or `undefined` when the queue is empty.
   */
  releaseNext(): string | undefined {
    return this.items.shift()
  }
}
