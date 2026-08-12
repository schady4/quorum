# Quorum

**Multiplayer AI in your terminal.** Friends and multiple AI models share one
live chat session — a single converged window on every end — where the AIs are
first-class participants: they use tools (MCP), loop, delegate across models,
and spin up new instances on request.

Model-agnostic by design. Claude, OpenAI, Meta/Llama, Kimi, and local /
open-source models all plug in behind one adapter interface. Install once, wire
up whichever providers you want.

> Status: **scaffold.** The architecture and milestone plan live in the sibling
> repo — [`multiplayer-ai/ROADMAP.md`](https://github.com/schady4/multiplayer-ai/blob/main/ROADMAP.md)
> ([tracking epic](https://github.com/schady4/multiplayer-ai/issues/8)). Quorum
> is the shipping CLI that plan produces.

Built by **Jarett Schadlich**.

---

## The idea

A chat room where every terminal is a **replica** on one shared CRDT surface —
that's what keeps everyone's window converged even under lag. A **DAG** ledger
under it holds the session's history, branching threads, and provenance (who —
human or which model — said what). AI participants join that room the same way a
human's terminal does; a **router** decides which model answers a given request
and can spin up new model instances that join as their own participants.

The CRDT + DAG core is ported from the proof-of-context demo in the sibling
repo; Quorum takes it off the browser and into the terminal, where MCP, tool
permissions, and shell access are native.

## Install

Published to npm (scoped, because `quorum` is taken):

```bash
npx @schady4/quorum --help
# or
npm install -g @schady4/quorum
```

First run prompts for credentials for whichever providers you enable — nothing
is collected for providers you don't use.

## Commands

```
quorum host [--port <n>]              Start a relay/room server            (M1)
quorum join <room> [--as <handle>]    Join a room from your terminal       (M1)
quorum setup                          Configure providers + credentials    (M5)
quorum providers                      List installable model providers
quorum --help                         Usage
```

`quorum providers` works today against the scaffold.

## Adding a model provider

Quorum is extensible at one seam: the **provider adapter**. To add a vendor,
implement [`ProviderAdapter`](src/providers/types.ts) in a new file under
`src/providers/` and register it in `src/providers/index.ts`. The router, the
room protocol, and the TUI never change — that's the whole point of the
interface.

## Layout

```
src/
  core/        CRDT live surface + DAG ledger (ported in M0)
  relay/       self-hostable room server / chat backbone (M1)
  tui/         Ink terminal chat window (M1)
  router/      multi-model routing + delegation (M3)
  providers/   the model adapters — the extensibility surface
  cli.ts       command entry point
```

## Develop

```bash
npm install
npm run dev -- providers     # run the CLI from source
npm run build                # compile to dist/
npm run typecheck
```

## License

MIT © Jarett Schadlich
