/**
 * dsh-cortex startup — command-line provider.
 *
 * Phase 1: parse a positional task (like headless) plus flags, publish a
 * startup service the runner consumes. Phase 2 replaces the one-shot runner
 * with a REPL loop; the provider stays (it owns the app's flag family).
 *
 * @module dsh-cortex/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'cortex-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner. */
export const CORTEX_STARTUP_SERVICE = 'cortexStartup'

/** What the runner row reads from {@link CORTEX_STARTUP_SERVICE}. */
export interface CortexStartupValues {
  /** The task text this invocation asked for (single-shot mode), if any. */
  task?: string | undefined
  /** Resume a specific session id. */
  resume?: string | undefined
  /** Resume the most recent session in this directory (no picker). */
  last?: boolean | undefined
  /** Open the resume picker (--resume without an id). */
  pick?: boolean | undefined
  /**
   * Run inline instead of in the terminal's alternate screen, so TUI rows stay
   * in the normal scrollback after exit (codex's --no-alt-screen).
   */
  noAltScreen?: boolean | undefined
}


/**
 * This app's command: an optional task positional, its description, and its
 * help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function cortexCommand(): Command {
  return new Command()
    .name('dsh --profile cortex')
    .description('Interactive terminal agent (codex-style); pass a task for one-shot mode.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'optional task text; without it, enter the interactive REPL')
    .option('--resume [sessionId]', 'resume a session in this directory (opens a picker when no id is given)')
    .option('--last', 'resume the most recent session in this directory without a picker')
    .option('--no-alt-screen', 'run inline, keeping the TUI rows in the terminal scrollback after exit')
    .addHelpText('after', `
Examples:
  dsh --profile cortex                    enter the interactive REPL (new session)
  dsh --profile cortex "run the tests"    one-shot task mode
  dsh --profile cortex --resume           pick a session from this directory to resume
  dsh --profile cortex --resume <id>      resume a specific session
  dsh --profile cortex --last             resume the most recent session in this directory
  dsh --profile cortex --no-alt-screen    inline mode (keep rows in scrollback after exit)
`)
}

/**
 * Parse and provide the startup values as an ordinary Cordis service. The
 * command's action publishes the parsed values.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = cortexCommand()
  program.action(() => {
    const task = program.args.join(' ').trim()
    const opts = program.opts<{ resume?: string | true; last?: boolean; altScreen?: boolean }>()
    ctx.provide(CORTEX_STARTUP_SERVICE, {
      ...(task === '' ? {} : { task }),
      ...(opts.last === true ? { last: true } : {}),
      // commander maps `--no-alt-screen` to `altScreen: false`; default is true.
      ...(opts.altScreen === false ? { noAltScreen: true } : {}),
      ...(opts.resume === true || opts.resume === ''
        ? { pick: true }                                    // bare --resume -> picker
        : opts.resume !== undefined ? { resume: opts.resume } : {}),
    } satisfies CortexStartupValues)
  })
  parseCmdline(ctx, program)
}
