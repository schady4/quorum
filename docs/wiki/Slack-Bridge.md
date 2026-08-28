# Slack Bridge (design)

> Status: **design / RFC.** Not implemented yet. The committed approach is a
> **self-hosted, single-workspace** bridge — the lowest policy surface and the one
> that fits Quorum's self-hosted ethos.

A Slack bridge is a **third kind of seat on the bus** (after the terminal and the
mobile app): a persisting `RoomClient` that relays **one Slack channel ⟷ one
Quorum room**, bidirectionally, run by someone who holds the room key. Everything
here exists to keep that relay from eroding what makes Quorum *Quorum*.

## Non-negotiables

1. **Multiplayer AI** — multiple humans + multiple AI seats in one room; Slack
   users can talk to any of them, and several at once.
2. **Model-agnostic seats** — `@claude`, `@gpt`, `@llama` all reachable from Slack.
3. **Full room behaviors** — delegation and fork/merge threads stay usable.
4. **Provenance** — who-said-what survives the crossing (per-user identity, below).
5. **Keys never touch Slack** — provider and room keys stay on trusted devices.
6. **No data loss** — a dropped connection or hard crash never eats messages;
   recovery is deterministic, not a coin flip.
7. **Honest encryption boundary** — the bridge decrypts the room and re-posts
   plaintext into Slack, so Slack can read bridged content. This is a *consensual
   gateway*, announced in the room, never silent.

## Identity — so the AIs (and people) know who they're talking to

**Per-user mapping (Model B):** each Slack user maps to a stable Quorum handle,
and the bridge posts each message **authored as that handle** (one `RoomClient`
per active Slack user, which also gives real presence). The AI seat then receives
real `{ author, content }` provenance and can address people by name. Outbound,
the bridge rewrites an AI's `@alice` into Slack's real `<@U…>` mention so the
right person is pinged. (Handles are shared-key labels, not cryptographic
identities — trusted because the *bridge* is trusted.)

## Command model — reaching Quorum without fighting Slack's `/`

Slack **owns the `/` namespace**: a raw `/fork A B` is intercepted as an unknown
slash command and never reaches the channel. The split that avoids all collision:

- **Talking to AIs is just chat.** `@claude summarize this` is ordinary message
  text (an AI handle isn't a Slack member, so it stays literal), relayed into the
  room; the seat replies. Multiple seats and delegation
  (`@claude delegate scribe using openai/gpt-5 …`) — all plain text.
- **Structured actions go under one registered command: `/quorum`.** Register
  exactly one Slack slash command and namespace everything beneath it, so it can
  never clash with Slack's built-ins or other apps:
  - `/quorum agent claude --provider anthropic` — seat an AI (see below)
  - `/quorum fork A B` · `/quorum set A owner alice` · `/quorum merge A B`
  - `/quorum status` — who's live, branches, bridge state
  It works over **Socket Mode** (no public URL); the bridge echoes results with
  `response_type: in_channel`.
- **`/quorum key …` is refused, on purpose.** Keys never go through Slack.

**Where a Slack-summoned AI runs:** on the **bridge host**, using the host's own
`quorum setup` credentials (a trusted machine). Slack users summon and talk to
AIs; they never see or supply a key. Seats running elsewhere (a laptop, the app)
are equally reachable — they're just seats on the bus.

## Continuity model — two windows, one room, no gap

Everything relayed **into** the room becomes a durable op, so native seats and the
AI are always on the full-record (superset) side. Slack is a *projection*, not a
CRDT replica. Close the seams:

- **The bridge is a persisting, auto-reconnecting seat** (`RoomStore` + reconnect)
  — on reconnect it replays missed ops from the relay's log; the Quorum side
  self-heals.
- **Two high-water-mark cursors**, persisted to disk: `slackTs` (last Slack `ts`
  relayed in) and `quorumOp` (last op relayed out). On restart: pull
  `conversations.history` since `slackTs`; replay ops since `quorumOp`.
- **Backfill on link** (optional): post the last _N_ Quorum messages into Slack for
  context — never the whole log.
- **Presence both ways** so nobody addresses a ghost: Model B surfaces Slack users
  in the roster; the bridge posts native joins/leaves + a `🔗 bridged to #general`
  banner into Slack.

## Durability — deterministic, not a coin flip

Correctness must **not depend on a graceful shutdown**; a `kill -9` recovers
identically. Idempotency both ways:

- **Inbound (Slack → Quorum):** derive the op id **deterministically from the
  Slack message `ts`**. Re-relaying yields the same id; the relay dedupes by id →
  re-delivery is a no-op. At-least-once + idempotent ⇒ effectively **exactly-once**.
- **Outbound (Quorum → Slack):** stamp each Slack post's `metadata` with its
  `quorumOp` id. On restart, scan recent history for the highest `quorumOp` already
  posted and resume past it → closes the post-then-crash duplicate window.
- **Cursors advance only after confirmation** and persist atomically.

**Graceful exit** (SIGINT/SIGTERM) then flushes in-flight relays, persists cursors,
posts `🔌 bridge offline` to both sides, and closes sockets — a nicety, not a
crutch, since an ungraceful exit loses nothing either.

## Slack policy & compliance (self-hosted, single-workspace)

This app is in Slack's **sensitive category** — its job is moving message content
out of a workspace to external participants and third-party AI. The self-hosted,
single-workspace path keeps the policy surface small. *(Not legal advice; verify
against Slack's current API Terms of Service, Acceptable Use Policy, and — only if
you ever list publicly — Marketplace review requirements.)*

**Why single-workspace is the low-bar path:** a workspace admin creates a **custom
app in their own workspace** and installs it. **No Slack review, no Marketplace
listing** — a trusted admin is opting their own org in. You still comply with the
API TOS; the requirements are mostly hygiene:

- **Minimal OAuth scopes, each justified** — likely `commands` (the `/quorum`
  command), `channels:history` + `channels:read`, `chat:write`, `users:read`
  (identity mapping), and `connections:write` for Socket Mode; add `files:*` /
  `reactions:*` only when v2 needs them. Nothing extra.
- **Security basics** — verify the Slack **signing secret** on inbound, store the
  bot token securely, HTTPS, respect the tiered **rate limits** (handle `429`,
  don't spam with huge backfills). **Socket Mode** so no public URL is needed.

**The crux — egress + AI (applies even self-hosted):**

1. **Transparency & consent.** Because content leaves Slack (to other room
   participants *and* to third-party LLMs), bridging must be **explicit**:
   admin-installed, **per-channel opt-in**, and an **in-channel banner**
   (`🔗 this channel is bridged to an external Quorum room + AI; messages are
   shared outside Slack`). That banner is non-optional.
2. **AI disclosure + no-training.** Disclose that third-party models process
   content, and use providers' **no-train API tiers** (Anthropic/OpenAI don't
   train on API data by default). Slack's API TOS forbids using Slack data to
   train ML without consent — honor it.
3. **Respect admin governance.** Enterprise Grid admins can approve/deny apps and
   run DLP; the bridge must function within those controls — and **some workspaces
   will block it by policy**, which is expected for an egress app. Don't fight it.
4. **No secrets in Slack.** `/quorum key` is refused; keys live on the bridge host.

**How the design already leans compliant:** the `🔗 bridged` announcement is the
transparency Slack expects; keys-never-in-Slack is clean data hygiene; per-channel
opt-in + admin install is proper authorization; the single namespaced `/quorum`
command is least-privilege.

**Public Marketplace listing** — deferred. It triggers full Slack review (security
questionnaire, published privacy policy, OAuth justification, and hard scrutiny of
the egress + AI). Approvable with strong consent UX + a real privacy policy +
no-train guarantees, but it's a deliberate later compliance project, not v1.

## Fidelity roadmap

- **v1** — text both ways, per-user identity, `/quorum` commands, the full
  continuity + durability model above. Correct before rich.
- **v2** — map Quorum control messages ↔ Slack **edits/deletes/reactions** (so the
  AI never acts on stale text), **blob attachments** ↔ `files.upload`, replies ↔
  Slack threads.

## Packaging

Ship as a **separate package** (`@schady4/quorum-slack` / a `quorum bridge slack`
entry) so `@slack/bolt` stays out of the core bundle. The bridge depends only on
the SDK's public surface (`RoomClient`, room crypto, control codecs) — a reference
consumer of "build on the bus," nothing privileged.
