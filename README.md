# Quorum

**Multiplayer AI in your terminal.** Friends and multiple AI models share one
live chat session — a single converged window on every end — where the AIs are
first-class participants: they use tools (MCP), loop, delegate across models,
and spin up new instances on request.

Model-agnostic by design. Claude, OpenAI, Meta/Llama, Kimi, and local /
open-source models all plug in behind one adapter interface. Install once, wire
up whichever providers you want.

> Status: **M0–M2 landed** — the CRDT/DAG substrate is ported and tested, the
> chat backbone works (run a relay, join from multiple terminals, share one
> converged stream), and an **AI participant** can hold a seat: it joins like
> any client, answers when @mentioned, and replies through a model provider.
> The model router (M3) that lets it delegate across models is next. The
> architecture and milestone plan live in the sibling repo —
> [`multiplayer-ai/ROADMAP.md`](https://github.com/schady4/multiplayer-ai/blob/main/ROADMAP.md)
> ([tracking epic](https://github.com/schady4/multiplayer-ai/issues/8)).

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
quorum host [--port <n>]                             Start a relay/room server   ✓
quorum join <room> [--as <handle>] [--relay <url>]   Join a room                 ✓
quorum agent <room> [--as <h>] [--provider <id>] [--model <id>]   Seat an AI     ✓
quorum setup                                         Configure providers + keys  (M5)
quorum providers                                     List installable providers  ✓
quorum --help                                        Usage
```

Try it locally — a relay, a human, and an AI seat sharing one converged room:

```bash
npm run build
node dist/cli.js host                          # terminal 1 — the relay
node dist/cli.js join lobby --as ada           # terminal 2 — you
ANTHROPIC_API_KEY=sk-... \
  node dist/cli.js agent lobby --as claude     # terminal 3 — an AI seat
```

Type in your seat; both windows converge. Say `@claude ...` to talk to the AI —
it reads the shared stream and replies into it. A late joiner catches up from
the relay's op log. (During development, swap `node dist/cli.js` for
`npm run dev --`.)

The AI seat is model-agnostic: `--provider openai|meta|kimi|local` selects the
vendor (once its adapter's `generate()` is implemented — Anthropic is wired
first), and `--model` picks the model. Credentials come from the environment
for now; `quorum setup` (M5) will prompt for them.

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
