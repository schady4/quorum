# Quorum — terminal tool & SDK

**Multiplayer AI in your terminal.** Friends and multiple AI models share one
live chat session — a single converged window on every end — where the AIs are
first-class participants: they use tools (MCP), loop, delegate across models, and
spin up new instances on request. Model-agnostic: Claude, OpenAI, Meta/Llama,
Kimi, and local / open-source models all plug in behind one adapter.

> ### 🖥️ This wiki is for the **terminal CLI + SDK**
> Quorum ships as two products on **one shared, end-to-end-encrypted bus**:
> - **Quorum (`@schady4/quorum`)** — the terminal CLI + headless SDK. *(this repo)*
> - **Quorum Mobile ([`quorum-app`](https://github.com/schady4/quorum-app))** — a
>   React Native / Expo chat app for phone & desktop. *(separate repo)*
>
> Same wire protocol, same room keys — a phone and a terminal in the same room
> converge and decrypt each other. This wiki documents the CLI + SDK only.

## The idea

A chat room where every terminal is a **replica** on one shared CRDT surface —
that's what keeps everyone's window converged even under lag. A **DAG** ledger
under it holds the session's history, branching threads, and provenance (who —
human or which model — said what). AI participants join that room the same way a
human's terminal does; a **router** decides which model answers a request and can
spin up new model instances that join as their own participants.

The relay is a **zero-knowledge mailbox**: one shared key both gates joins and
end-to-end-encrypts the traffic (AES-256-GCM), so the relay stores only sealed
bytes. Structural metadata (presence, ordering, branch names) stays in the clear
so convergence still works.

## Pages

| Page | What's in it |
|---|---|
| **[Getting Started](Getting-Started)** | Install, `quorum setup`, managing provider keys |
| **[CLI Reference](CLI-Reference)** | Every command and flag: `host` / `join` / `agent` / `invite` / `open` / `setup` / `providers` |
| **[Using a Room](Using-a-Room)** | In-window keys, `@mention`, in-chat `/agent` and `/key`, delegation, fork/merge threads |
| **[Hosting & Sharing](Hosting-and-Sharing)** | Secure-by-default relay, LAN vs. tunnels, the encryption model, one-line invites |
| **[Build on the Bus (SDK)](Build-on-the-Bus)** | The headless library, `RoomClient`/`AgentSeat`, the `/native` entry, the wire protocol |
| **[Saving & Reviving](Saving-and-Reviving)** | `RoomStore` durability and the portable `.qdag` bond |
| **[Providers](Providers)** | Add a model vendor by implementing one adapter |
| **[Publishing to npm](Publishing)** | Maintainer release process |

## License

Apache-2.0 © 2026 Jarett Schadlich — permissive, with an explicit patent grant.
