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
> and packaging: `quorum setup` prompts for the credentials of whichever
> providers you enable and stores them locally, and the package publishes to
> npm so friends install it in one line. Rooms are **secure by default** — one
> shared key both gates joins and end-to-end encrypts the traffic, so the relay
> is a zero-knowledge mailbox — and clients **auto-reconnect** through drops.
> 215 tests across 28 suites. Plan and
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

Every key you enter is live-checked with one minimal real call right there in
the prompt, so a bad or out-of-funds key is caught immediately — not the first
time an AI seat tries to use it. `quorum agent` runs the same check on start,
so a seat with a dead key refuses to join instead of sitting in the room
silently failing on every future `@mention`.

Managing what's saved doesn't require re-running the whole wizard:

```bash
quorum setup --status             # what's configured, per provider (masked)
quorum setup --unset anthropic    # drop just one provider's keys
quorum setup --wipe               # delete everything and start clean
```

Inside the interactive prompt, typing `-` for a saved value clears it.

## Commands

```
quorum host [--port <n>] [--key <secret>] [--open] [--persist [dir]]  Relay server ✓
quorum join <room> [--as <h>] [--relay <url>] [--key <s>] [--provider <id>] [--persist]  Join ✓
quorum agent <room> [--as <h>] [--provider <id>] [--model <id>] [--key <s>]  AI   ✓
quorum open <file.qdag> [--key <s>] [--relay <url>] [--as <h>]   Revive a save   ✓
quorum setup                                         Configure providers + keys  ✓
quorum setup --status | --unset <provider> | --wipe  Inspect / remove / reset    ✓
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

Try it on one machine — a relay, a human, and an AI seat sharing one converged
room, each in its own terminal:

```bash
quorum host --open                    # terminal 1 — the relay (keyless, for local use)
quorum join lobby --as ada            # terminal 2 — you
ANTHROPIC_API_KEY=sk-... \
  quorum agent lobby --as claude      # terminal 3 — an AI seat
```

Type in your seat; both windows converge. Say `@claude ...` to talk to the AI —
it reads the shared stream and replies into it. A late joiner catches up from
the relay's op log. (Working from a clone instead of an install? `npm run build`
first, then run `node dist/cli.js …` — or `npm run dev -- …` straight from
source.)

In the window: **Enter** sends, **↑/↓** recall your previous messages,
**←/→ · Home/End** move the cursor, **PgUp/PgDn** scroll back through the
history, **Esc** quits. The message pane is bounded to the terminal and stays
pinned to the newest message unless you scroll up.

**You don't need a third terminal for your own AI.** A seat can be seated
right from the chat window:

```
/agent claude --provider anthropic --model claude-sonnet-5
/key anthropic sk-ant-...          (only if that provider isn't configured yet)
```

`/agent` seats a model in-process, using the room you're already in — no
second `quorum agent` invocation, no separate shell. If the provider needs a
key you haven't set, it tells you instead of failing silently; `/key` saves
one right there (masked on screen as you type it) to the same store `quorum
setup` writes to, so it's there for next time too. Both stay local like
`/fork`/`/set`/`/merge` — neither is ever sent to the room.

## Sharing with friends

Drop `--open` and `quorum host` is secure by default: it prints a room key and a
ready-to-send invite line. Hand the whole line to each friend — that's the setup.

**Same network (same Wi-Fi / LAN).** Friends run the LAN invite `host` printed:

```bash
quorum join <room> --relay ws://<your-lan-ip>:8787 --key <key>
```

**Different networks.** A private IP isn't reachable from outside, and port 8787
is often firewalled — so expose the relay through a tunnel, which also gives you
a public `wss://` URL over 443 that restrictive networks allow. `host` prints the
exact commands; for example:

```bash
ngrok http 8787       # then share: quorum join <room> --relay wss://<id>.ngrok.app --key <key>
```

Either way the room is end-to-end encrypted with that key, so neither the tunnel
nor the relay ever sees your messages — only people holding the key do. Drop the
Wi-Fi and clients reconnect on their own.

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

## Build on the bus (the SDK)

Under the terminal UI, Quorum's core is a **headless conversation bus** — a
relay plus an end-to-end-encrypted, provenance-carrying, converged log. It's the
package's library entry (no Ink/React pulled in), so a desktop or mobile surface,
a bridge into Slack / Discord / Twitch, or an external agent are all just **seats
on the same bus**:

```ts
import { startRelay, RoomClient, AgentSeat, createModelResponder } from "@schady4/quorum";

// host a room (or point a client at someone else's relay)
const relay = await startRelay({ port: 8787, authToken });

// join as a seat — the primitive every surface and bridge is built from
const room = new RoomClient("ws://localhost:8787", "lobby", "ada", roomKey);
room.on("update", (entries) => render(entries)); // your UI, or a bridge sink
room.connect();
room.send("hello from anywhere");

// seat an agent (any Responder — a model, or a bridge to an external agent)
new AgentSeat({
  relayUrl: "ws://localhost:8787",
  room: "lobby",
  handle: "claude",
  key: roomKey,
  respond: createModelResponder({ providerId: "anthropic" }),
}).start();
```

The wire contract is documented in [PROTOCOL.md](PROTOCOL.md): anything that
speaks it and holds the room key is a first-class participant, indistinguishable
on the bus from any other. That's the whole basis for a universal conversation
pipeline instead of another silo.

### On a phone or in the browser — `@schady4/quorum/native`

The default entry pulls in Node-only machinery (on-disk saves, the credential
store, the AI-seat runtime) that a **React Native or web** app can't bundle. For
those surfaces import the `/native` entry instead — the same `RoomClient`, room
crypto, and protocol, with everything that touches `node:fs`/`os`/`zlib` left on
the server:

```ts
import { RoomClient, roomCrypto } from "@schady4/quorum/native";
```

The transport and crypto resolve to pure-JS, platform-native implementations
automatically (Metro/web bundlers follow the package's `react-native`/`browser`
field maps), and their outputs match the Node build byte-for-byte — so a phone
and a laptop in the same room derive the same keys and decrypt each other. A
[guard test](test/native.test.ts) walks this entry's import graph on every run
and fails if a Node-only module ever creeps back in.

## Saving & reviving sessions

Two storage mechanisms sit on the same op-log substrate (details in
[SAVE-FORMAT.md](SAVE-FORMAT.md)), both encrypted at rest with the room key:

- **`RoomStore`** — continuous per-client durability, wired into `RoomClient`
  and switched on with `quorum join … --persist`. A persisting client keeps every
  (sealed) frame it sees, **restores its history on restart** (even before the
  relay answers, or fully offline), and **re-seeds a relay** that lost its memory.
  Any client becomes a backup — no server database needed.
- **The `.qdag` bond** — a small, portable, *revivable* save. It binds the
  roster and the complete decision-DAG (branches, merges, provenance) with the
  message thread; anyone holding the file **and the room key** can revive it into
  a live room. Small because a finished save drops the live-only CRDT plumbing
  and keeps just the replayable result, interned + gzipped + sealed.

**Torchbearer save.** When the last human quits a non-empty room (AI seats don't
hold the torch), the chat window offers to save it before it's gone — `[y/N]`.
Say yes and it writes a sealed `.qdag` under `~/.quorum/saves/` and prints how to
bring it back.

**Revive.** `quorum open <file.qdag> --key <key>` brings a saved room back to
life: it hosts a fresh relay, replays the bond (streamed, so even a huge save
stays bounded-memory), drops you into the room with the full history and the
same decision-DAG — **original authors preserved** — and prints an invite so the
people who were there can rejoin and pick up where they left off. Point it at an
existing relay with `--relay`. Everything's exported from the SDK too
(`RoomStore`/`FileRoomStore`, `encodeSave`/`decodeSave`/`framesFrom`/`streamFrames`,
`isLastHuman`/`saveSessionToDir`, `RoomClient.replay`).

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
