# Quorum

**Multiplayer AI in your terminal.** Friends and multiple AI models share one
live chat session — a single converged window on every end — where the AIs are
first-class participants: they use tools (MCP), loop, delegate across models,
and spin up new instances on request.

Model-agnostic by design. Claude, OpenAI, Meta/Llama, Kimi, and local /
open-source models all plug in behind one adapter interface. Install once, wire
up whichever providers you want.

> Status: **feature-complete (M0–M5).** Substrate, chat backbone, AI
> participants, multi-model router with delegation, DAG threads in live chat,
> and now packaging: `quorum setup` prompts for the credentials of whichever
> providers you enable and stores them locally, and the package publishes to
> npm so friends install it in one line. 96 tests across 15 suites. Plan and
> architecture live in the sibling repo —
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

Then configure whichever models you want:

```bash
npx @schady4/quorum setup
```

`setup` walks the providers, asks which to enable, and prompts for each one's
keys (secrets masked). Values are written to `~/.quorum/credentials.json`
(owner-only) and sent straight to each provider — nothing is collected for
providers you don't use, and nothing leaves your machine except the API calls
themselves. A one-off `ANTHROPIC_API_KEY=… quorum agent …` env var overrides the
stored value.

## Commands

```
quorum host [--port <n>] [--key <secret>] [--open]   Start a relay/room server   ✓
quorum join <room> [--as <handle>] [--relay <url>] [--key <secret>]   Join       ✓
quorum agent <room> [--as <h>] [--provider <id>] [--model <id>] [--key <s>]  AI   ✓
quorum setup                                         Configure providers + keys  ✓
quorum providers                                     List installable providers  ✓
quorum --help                                        Usage
```

**Room access & encryption.** `quorum host` is secure by default: it generates
a shared room key and prints a ready invite line (`… --relay … --key <secret>`).
From that one key each client derives, independently, a relay **auth token** and
an **encryption key**. The relay is configured with only the token — a one-way
derivation — so it gates joins but can't read the traffic: chat and decision
values are sealed with AES-256-GCM end-to-end, and the relay is a zero-knowledge
mailbox. Structural metadata (who's present, message ordering, branch names and
decision keys) stays in the clear so convergence still works. Pass your own key
with `--key`, or run a keyless, unencrypted local relay with `--open`.

Try it locally — a relay, a human, and an AI seat sharing one converged room:

```bash
npm run build
node dist/cli.js host --open                    # terminal 1 — the relay (keyless, local)
node dist/cli.js join lobby --as ada            # terminal 2 — you
ANTHROPIC_API_KEY=sk-... \
  node dist/cli.js agent lobby --as claude      # terminal 3 — an AI seat
```

Type in your seat; both windows converge. Say `@claude ...` to talk to the AI —
it reads the shared stream and replies into it. A late joiner catches up from
the relay's op log. (During development, swap `node dist/cli.js` for
`npm run dev --`.)

The AI seat is model-agnostic: `--provider anthropic|openai|meta|kimi|local`
selects the vendor and `--model` picks the model. All five have a real
`generate()` — OpenAI, Meta/Llama, Kimi, and local servers share one
OpenAI-compatible HTTP path, so any OpenAI-compatible endpoint works too.
Credentials come from `quorum setup` (stored locally) or a `KEY=… quorum agent …`
environment override — see [Install](#install).

**Delegation.** A seat can spin up another seat on a different model to own a
subtask. In the room:

```
@claude delegate scribe using openai/gpt-5 to summarize the thread so far
```

`claude` brings up a new seat named `scribe` on GPT-5; it joins the room as its
own participant, does the task, and shares the result back to the group — the
same way any seat does. Delegation nests: a spawned seat can delegate too.

**Threads (fork / merge).** A room carries a shared decision-state — a small
key/value store everyone converges on. From the input line:

```
/fork A B                       split the trunk into two branches
/set A owner ada                advance branch A
/set B deadline monday          advance branch B (concurrently)
/merge A B                      reconcile back to trunk
```

Disjoint edits merge mechanically with zero inference. If two branches set the
same key incompatibly, the merge escalates to a single AI arbitration call —
but only if a seat with a provider is present (join with `--provider` to let
your seat arbitrate). The resolved values ride inside the merge op, so every
replica lands on the same trunk. The ledger panel shows trunk, branches, and
recent history live.

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

Licensed under [Creative Commons Attribution-NonCommercial 4.0 International
(CC BY-NC 4.0)](LICENSE) © Jarett Schadlich. You may share and adapt the work
with attribution, but **not for commercial purposes** — commercial use requires
separate permission from Jarett Schadlich.
