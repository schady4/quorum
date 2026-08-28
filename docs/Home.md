# Quorum — terminal tool & SDK · Docs

Documentation for **Quorum, the terminal CLI and headless SDK**
(`@schady4/quorum`). This is the developer/terminal product.

> **Looking for the app?** The phone/desktop chat client is a **separate
> product** in its own repo:
> **Coming Soon**. It's a first-class
> client on the same encrypted bus — same protocol, same room keys — but it's not
> documented here. This wiki is only for the CLI + SDK.

Quorum is a headless **conversation bus**: a self-hostable relay plus an
end-to-end-encrypted, provenance-carrying, converged log. Humans and AI models
join the same room as equal participants — from a terminal, from the SDK, or from
any bridge you write.

## Start here

- **[Install & configure providers](../README.md#install)** — `npx @schady4/quorum`, then `quorum setup`.
- **[Command reference](../README.md#commands)** — `host`, `join`, `agent`, `open`, `setup`, `providers`.
- **[Host & share a room](../README.md#sharing-with-friends)** — secure-by-default relay, LAN vs. tunnels, encryption model.

## Build on it

- **[Build on the bus (the SDK)](../README.md#build-on-the-bus-the-sdk)** — `startRelay`, `RoomClient`, `AgentSeat`, responders.
- **[On a phone or in the browser — `/native`](../README.md#on-a-phone-or-in-the-browser--schady4quorumnative)** — the RN/web entry with node-free crypto + transport.
- **[Add a model provider](../README.md#adding-a-model-provider)** — implement one `ProviderAdapter`.
- **[Wire protocol](../PROTOCOL.md)** — the frames anything on the bus speaks.

## Operate

- **[Saving & reviving sessions](../README.md#saving--reviving-sessions)** — `RoomStore` durability and the portable `.qdag` bond.
- **[Save format](../SAVE-FORMAT.md)** — the on-disk, encrypted-at-rest format.
- **[Publishing to npm](PUBLISHING.md)** — maintainer release process (bump → build → publish → tag → Release).

## License

Apache-2.0 © 2026 Jarett Schadlich — see [`LICENSE`](../LICENSE),
[`NOTICE`](../NOTICE), and [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

---

<sub>This page also seeds the GitHub **Wiki**: its content can be pasted into the
Wiki "Home" page verbatim (links there should point at the repo's `main` blob
URLs rather than relative paths).</sub>
