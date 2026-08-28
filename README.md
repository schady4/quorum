# Quorum

**Multiplayer AI in your terminal.** Friends and multiple AI models share one
live chat session — a single converged window on every end — where the AIs are
first-class participants: they use tools (MCP), loop, delegate across models, and
spin up new instances on request. Model-agnostic by design: Claude, OpenAI,
Meta/Llama, Kimi, and local / open-source models all plug in behind one adapter.

[![npm](https://img.shields.io/npm/v/@schady4/quorum?color=0A84FF)](https://www.npmjs.com/package/@schady4/quorum)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-wiki-brightgreen)](https://github.com/schady4/quorum/wiki)

> ### 🖥️ This repo is the **terminal tool + SDK**
> Quorum ships as two products on **one shared, end-to-end-encrypted bus**:
> - **Quorum (this repo, `@schady4/quorum`)** — the **terminal CLI** and headless
>   **SDK**. Host/join rooms from your shell, seat AI models, build bridges.
> - **Quorum Mobile ([`quorum-app`](https://github.com/schady4/quorum-app))** — a
>   **React Native / Expo chat app** for phone and desktop.
>
> Same [wire protocol](PROTOCOL.md), same room keys — a phone and a terminal in
> the same room converge and decrypt each other.

## Highlights

- **One converged room** — every terminal is a CRDT replica, so windows stay in
  sync even under lag, with a DAG ledger tracking who (human or which model) said
  what.
- **AI seats, model-agnostic** — Claude, GPT, Llama, Kimi, or a local model join
  as real participants. `@mention` to talk; they use MCP tools, loop, and can
  **delegate** subtasks to other models.
- **Secure by default** — one shared key gates joins *and* end-to-end-encrypts the
  traffic (AES-256-GCM). The relay is a **zero-knowledge mailbox** that only ever
  holds sealed bytes.
- **Fork / merge threads** — branch a shared decision-state and reconcile it back;
  incompatible edits escalate to a single AI arbitration call.
- **Save & revive** — portable, encrypted `.qdag` session bonds plus per-client
  durability; bring a whole conversation back to life with `quorum open`.
- **Build on the bus** — it's a headless SDK first. A phone app, a Slack/Discord
  bridge, or a custom client are all just **seats on the same bus**.

## Quickstart

```bash
npx @schady4/quorum setup            # configure whichever model providers you want
```

Try it on one machine — a relay, a human, and an AI seat sharing one converged
room, each in its own terminal:

```bash
quorum host --open                    # terminal 1 — the relay (keyless, for local use)
quorum join lobby --as ada            # terminal 2 — you
ANTHROPIC_API_KEY=sk-... \
  quorum agent lobby --as claude      # terminal 3 — an AI seat
```

Type in your seat; both windows converge. Say `@claude …` to talk to the AI.
Hosting for friends? `quorum host` prints an invite, and `quorum invite` turns it
into a copy-paste message.

## 📖 Documentation

Full docs live in the **[Wiki](https://github.com/schady4/quorum/wiki)**:

| Page | What's in it |
|---|---|
| **[Getting Started](https://github.com/schady4/quorum/wiki/Getting-Started)** | Install, `quorum setup`, managing provider keys |
| **[CLI Reference](https://github.com/schady4/quorum/wiki/CLI-Reference)** | Every command + flag: `host` / `join` / `agent` / `invite` / `open` / `setup` |
| **[Using a Room](https://github.com/schady4/quorum/wiki/Using-a-Room)** | `@mention`, in-chat `/agent` & `/key`, delegation, fork/merge threads |
| **[Hosting & Sharing](https://github.com/schady4/quorum/wiki/Hosting-and-Sharing)** | Secure relay, LAN vs. tunnels, the encryption model, one-line invites |
| **[Build on the Bus (SDK)](https://github.com/schady4/quorum/wiki/Build-on-the-Bus)** | The headless library, `RoomClient`/`AgentSeat`, the `/native` entry |
| **[Saving & Reviving](https://github.com/schady4/quorum/wiki/Saving-and-Reviving)** | `RoomStore` durability and the portable `.qdag` bond |
| **[Providers](https://github.com/schady4/quorum/wiki/Providers)** | Add a model vendor by implementing one adapter |
| **[Publishing to npm](https://github.com/schady4/quorum/wiki/Publishing)** | Maintainer release process |

Deeper references live in-repo: the wire contract in [PROTOCOL.md](PROTOCOL.md)
and the on-disk format in [SAVE-FORMAT.md](SAVE-FORMAT.md). The wiki's source is
versioned under [`docs/wiki/`](docs/wiki/) — edit there and run
`bash docs/wiki/publish.sh` to sync.

## License

Licensed under the [Apache License 2.0](LICENSE) © 2026 Jarett Schadlich — a
permissive open-source license with an explicit patent grant, so you're free to
use, modify, and build on Quorum (including commercially) as long as you keep the
license and attribution notices. See [`NOTICE`](NOTICE) and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Built by **Jarett Schadlich**.
