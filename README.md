# dsh-cortex

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

## Development

```bash
pnpm install
pnpm build
```

## License

MIT
