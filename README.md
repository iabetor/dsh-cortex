# cortex

An interactive codex-style terminal CLI for DeepSeek Harness. Instead of the
one-shot `headless` profile (one task, then exit), cortex keeps one persistent
Agent/Session alive and lets you prompt it turn after turn in a terminal REPL —
like `codex` or `claude` CLI.

> **Status: proof of concept.** This project currently validates that an
> external (out-of-tree) plugin can drive a dsh Agent the same way
> `@deepseek-ai/dsh-headless` does, then evolves into an interactive loop.

## How it works

The canonical single-turn driver lives in
`@deepseek-ai/dsh-headless` (`packages/bundle/headless/src/index.ts` in the
harness repo). Cortex replicates that contract:

1. inject `agentDefaultModel` / `agents` / `sessions`
2. create one Agent through the core registry (`ctx.agents.create()`)
3. send a user turn (`createUserMessage`)
4. subscribe to `agent/assistant-stream` for live text/reasoning/tool deltas
5. derive the final text by scanning `SessionEvent`s (`session.eventAt`)

The difference: headless exits after one turn; cortex loops.

## Install (from source, current)

cortex is **not published to npm** yet, and it is a dsh *profile plugin* rather
than a standalone binary — so installing means: get the harness CLI, put this
repo somewhere, then register a `cortex` profile that loads it.

**Prerequisites**

| Requirement | Why |
|---|---|
| DeepSeek Harness CLI (`dsh` on PATH) | cortex runs *inside* dsh; the `cortex` command wraps `dsh --profile cortex` |
| Node.js ≥ 20 + pnpm | build and package manager |
| A harness checkout that provides `@deepseek-ai/dsh-base` and friends | the profile's bundle list references them |

**Steps**

```bash
# 1. Clone and build this repo
git clone git@github.com:iabetor/dsh-cortex.git
cd dsh-cortex
pnpm install
pnpm build

# 2. Create the dsh profile that loads cortex
mkdir -p ~/.dsh/profiles/cortex
cd ~/.dsh/profiles/cortex
```

Write `~/.dsh/profiles/cortex/package.json` (adjust the two `link:` paths to
your machine — the first is this repo, the second is your harness checkout's
workspace package):

```json
{
  "name": "dsh-profile-cortex",
  "private": true,
  "dependencies": {
    "dsh-cortex": "link:/absolute/path/to/dsh-cortex",
    "@deepseek-ai/dsh-workspace": "link:/absolute/path/to/deepseek-harness/packages/workspace/workspace"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-cortex"],
      "patchReload": "startup"
    }
  }
}
```

```bash
# 3. Install the profile's dependencies
cd ~/.dsh/profiles/cortex
pnpm install

# 4. (optional) make the `cortex` command available globally
#    Either link this repo's bin, or use the dsh invocation directly.
npm link /absolute/path/to/dsh-cortex     # provides the `cortex` command
```

**Run**

```bash
cortex                    # interactive REPL
cortex "任务描述"           # one-shot: run the task, print the answer, exit
cortex --resume           # pick a session of this directory to resume
cortex --last             # resume the most recent session of this directory
```

If `cortex` is not linked, the equivalent invocation is:

```bash
dsh --profile cortex
```

The `cortex` command is a thin wrapper (`bin/cortex.js`) that runs
`dsh --profile cortex` with your arguments passed through. Set `DSH_BIN` if
`dsh` lives somewhere not on `PATH`.

## Why not `npm install -g` yet

Two blockers, both outside this repo:

1. **The npm name is taken.** `dsh-cortex` on npm is an unrelated package;
   publishing under it would fail.
2. **Harness packages are not on npm at the versions this needs.** cortex's
   peer dependencies (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`)
   resolve to a fork of the harness, which is not published. A public install
   needs the harness dependency story solved first.

Until then, the from-source steps above are the supported path.

## Features

- **Persistent REPL** — one Agent/Session across turns, streaming text,
  reasoning, and tool output.
- **Session management** — sessions grouped by working directory (codex-style
  cwd-as-group); `--resume` picker and `--last`.
- **Terminal question UI** — when the agent calls `ask_user_question`, options
  render as a picker with a free-text "其他" row; multi-select supported.
- **Sandbox approvals** — a confined tool that wants to act outside the
  workspace asks in the TUI (allow-once / remember for the session / reject
  with a reason fed back to the model).
- **Question alert** — if you walk away while the agent is waiting on a
  question, cortex sends a macOS notification after 60 seconds (`osascript`,
  no extra dependency).
- **Cancel a turn** — `Escape` while the agent is running.
- **Input model** — with a typed draft: `Enter` queues when busy (auto-sent
  after the turn), `Tab` steers into the running turn; when idle both send
  directly.

## Development

```bash
pnpm install
pnpm build        # tsdown → lib/
pnpm typecheck
pnpm test         # vitest
```

## License

MIT
