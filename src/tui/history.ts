/**
 * Shell-style draft history for cortex's composer, matching codex's rule
 * (`chat_composer_history.rs::should_handle_navigation`):
 *
 * - an EMPTY draft: Up/Down walk older/newer entries;
 * - a NON-empty draft: Up/Down are ordinary cursor movement, so multiline
 *   editing keeps working — history is only continued while the draft still
 *   equals the entry that was recalled.
 *
 * The class is transport-free so the recall rules can be unit-tested.
 *
 * @module dsh-cortex/tui/history
 */

/** Outcome of an Up/Down press. */
export interface HistoryStep {
  /**
   * Whether the key was consumed as history navigation. When false the caller
   * should treat Up/Down as normal cursor movement.
   */
  readonly handled: boolean
  /** Draft to show when handled (the caller's draft when not). */
  readonly value: string
  /** Cursor to place when handled. */
  readonly cursor: number
}

/** Newest-first ring of submitted drafts with shell-like recall. */
export class DraftHistory {
  /** Oldest → newest, so the last element is the most recent submission. */
  private readonly entries: string[] = []
  /** Index into `entries` while browsing, or -1 when not browsing. */
  private index = -1
  /** The draft that was in the box when browsing started. */
  private stash = ''

  /** Most recent entry, or undefined when nothing was submitted yet. */
  private get newest(): string | undefined {
    return this.entries[this.entries.length - 1]
  }

  /** Whether any entry can be recalled. */
  get size(): number {
    return this.entries.length
  }

  /**
   * Record a submitted draft. Empty/duplicate-of-last drafts are skipped, so
   * repeated submits do not flood the recall list.
   * @param text - the submitted draft.
   */
  record(text: string): void {
    const trimmed = text
    if (trimmed.trim() === '') return
    if (this.newest === trimmed) return
    this.entries.push(trimmed)
    this.reset()
  }

  /** Stop browsing and forget the stashed draft (called on submit). */
  reset(): void {
    this.index = -1
    this.stash = ''
  }

  /**
   * Walk one entry older (Up).
   * @param draft - the composer's current draft.
   * @param cursor - the composer's cursor offset.
   * @returns whether the key was consumed, plus the draft/cursor to show.
   */
  up(draft: string, cursor: number): HistoryStep {
    if (this.entries.length === 0) return { handled: false, value: draft, cursor }
    if (!this.canContinue(draft, cursor)) return { handled: false, value: draft, cursor }

    if (this.index === -1) {
      // Start browsing: stash the draft so Down can restore it.
      this.stash = draft
      this.index = this.entries.length - 1
    } else if (this.index > 0) {
      this.index -= 1
    } else {
      return { handled: true, value: draft, cursor } // already oldest
    }
    const value = this.entries[this.index] as string
    return { handled: true, value, cursor: value.length }
  }

  /**
   * Walk one entry newer (Down).
   * @param draft - the composer's current draft.
   * @param cursor - the composer's cursor offset.
   * @returns whether the key was consumed, plus the draft/cursor to show.
   */
  down(draft: string, cursor: number): HistoryStep {
    if (this.index === -1) return { handled: false, value: draft, cursor }
    if (!this.canContinue(draft, cursor)) return { handled: false, value: draft, cursor }

    if (this.index < this.entries.length - 1) {
      this.index += 1
      const value = this.entries[this.index] as string
      return { handled: true, value, cursor: value.length }
    }
    // Past the newest entry: restore whatever was in the box before browsing.
    const restored = this.stash
    this.reset()
    return { handled: true, value: restored, cursor: restored.length }
  }

  /**
   * Whether Up/Down may act as history for this draft state (codex's rule):
   * an empty draft always may; otherwise only while the draft still equals the
   * recalled entry and the cursor sits at a line boundary.
   */
  private canContinue(draft: string, cursor: number): boolean {
    if (draft === '') return true
    if (cursor !== 0 && cursor !== draft.length) return false
    return this.index !== -1 && this.entries[this.index] === draft
  }
}
