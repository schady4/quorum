# Design: Slack bridge

> Status: **design / RFC.** Not implemented. Captures the architecture so the
> bridge preserves Quorum's core values instead of quietly eroding them.

A Slack bridge is a **third kind of seat on the bus** (after the terminal and the
mobile app): a persisting `RoomClient` that relays one Slack channel ⟷ one Quorum
room, bidirectionally. Everything below exists to keep that relay from breaking
the things that make Quorum *Quorum*.

## Non-negotiables (what the bridge must not sacrifice)

1. **Multiplayer AI.** Multiple humans + multiple AI seats in one room; Slack
   users can talk to any of them, and to several at once.
2. **Model-agnostic seats.** `@claude`, `@gpt`, `@llama` all reachable from Slack.
3. **Full room behaviors** — delegation and fork/merge threads — remain usable
   from Slack, not just plain chat.
4. **Provenance.** Who-said-what survives the crossing (per-user identity, below).
5. **Keys never touch Slack.** Provider API keys and room keys stay on trusted
   devices; nothing secret is ever typed into a Slack message.
6. **No data loss.** A dropped connection or a hard crash must never silently eat
   messages — recovery is deterministic, not a coin flip.
7. **Honest encryption boundary.** The bridge decrypts the room (it holds the
   key) and re-posts plaintext into Slack, so Slack can read bridged content. This
   is a *consensual gateway*, announced in the room — never silent.

## Identity — so the AIs (and people) know who they're talking to

Per-user mapping (**Model B**): each Slack user maps to a stable Quorum handle,
and the bridge posts each message **authored as that handle** (via one
`RoomClient` per active Slack user, which also gives real presence). The AI seat
then receives real `{ author, content }` provenance and can address people by
name. On the way out, the bridge rewrites an AI's `@alice` into Slack's real
`<@U…>` mention, so the right person gets pinged. (Handles are shared-key labels,
not cryptographic identities — trusted because the *bridge* is trusted.)

## Command model — reaching Quorum without fighting Slack's `/`

Slack **owns the `/` namespace**: a raw `/fork A B` is intercepted by Slack as an
(unknown) slash command and never reaches the channel, so Quorum's in-chat
`/`-commands can't be typed directly. The split that avoids all collision:

- **Talking to AIs is just chat.** `@claude summarize the thread` is ordinary
  message text (an AI handle isn't a Slack member, so it stays literal), relayed
  into the room; the seat sees its mention and replies. Multiple seats,
  delegation (`@claude delegate scribe using openai/gpt-5 …`) — all plain text,
  no special casing.
- **Structured room actions go under one registered command: `/quorum`.** We
  register exactly one Slack slash command and namespace everything beneath it, so
  it can never clash with Slack's built-ins or other apps:
  - `/quorum agent claude --provider anthropic` — seat an AI (see below)
  - `/quorum fork A B` · `/quorum set A owner alice` · `/quorum merge A B`
  - `/quorum status` — who's live (humans + seats), branches, bridge state
  - `/quorum whoishere`, `/quorum leave`, etc.

  The bridge receives the `/quorum …` payload (works over Socket Mode, no public
  URL) and maps it to the room op, echoing a result into the channel with
  `response_type: in_channel`.
- **`/quorum key …` is refused, on purpose.** Keys never go through Slack; the
  bridge replies with a pointer to set it on the device/CLI. Non-negotiable #5.

### Where a Slack-summoned AI actually runs

AI seats are compute + a key, and neither belongs in Slack. So a seat summoned
with `/quorum agent …` runs **on the bridge host**, using the bridge host's own
`quorum setup` credentials (a trusted machine). Slack users summon and talk to
AIs; they never see or supply a key. Seats summoned elsewhere (someone's laptop,
the mobile app) are equally reachable — they're just seats on the bus.

## Continuity model — two windows, one room, no gap

Everything relayed **into** the room becomes a durable op, so the native seats and
the AI are always on the full-record (superset) side. The asymmetry is that Slack
is a *projection*, not a CRDT replica. Close the seams with:

- **The bridge is a persisting, auto-reconnecting seat** (`RoomStore` + reconnect,
  same machinery every client has). On reconnect it replays missed ops from the
  relay's log — the Quorum side self-heals.
- **Two high-water-mark cursors**, persisted to disk:
  - `slackTs` — the last Slack `ts` relayed *into* the room.
  - `quorumOp` — the last Quorum op id relayed *out* to Slack.
  On restart: pull `conversations.history` since `slackTs`; replay ops since
  `quorumOp`.
- **Backfill on link** (optional): post the last _N_ Quorum messages into Slack so
  Slack users get context — never the whole log (spammy).
- **Presence both ways** so nobody addresses someone who "isn't there": Model B
  surfaces Slack users in the room roster, and the bridge posts native joins/
  leaves + a `🔗 bridged to #general` banner into Slack.

## Durability — deterministic, not a coin flip

Correctness must **not depend on a graceful shutdown**; a `kill -9` must recover
just as cleanly. The mechanism is idempotency on both directions:

- **Inbound (Slack → Quorum):** derive the op id **deterministically from the
  Slack message `ts`**. Re-relaying the same Slack message yields the *same* op
  id, and the relay dedupes ops by id — so re-delivery after a crash is a no-op.
  At-least-once + idempotent ⇒ effectively **exactly-once**.
- **Outbound (Quorum → Slack):** stamp each Slack post's `metadata` with its
  source `quorumOp` id. On restart, scan recent channel history for the highest
  `quorumOp` already posted and resume past it — closing the post-then-crash
  duplicate window without native Slack idempotency.
- **Cursors are advanced only after confirmation** (an inbound op only after it
  appears in the confirmed log; `quorumOp` only after a successful Slack post),
  and persisted atomically.

**Graceful exit** (SIGINT/SIGTERM) then becomes a nicety, not a crutch: flush
in-flight relays, persist cursors, post `🔌 bridge offline` to both sides, close
sockets. But because of the idempotency above, an *ungraceful* exit loses nothing
either — the next start resumes exactly where it left off. That is the "fully
exists" bar: **crash-safe first, graceful-nice second.**

## Fidelity roadmap

- **v1** — text both ways, per-user identity, `/quorum` commands, the full
  continuity + durability model above. Correct before rich.
- **v2** — map Quorum control messages ↔ Slack: **edits/deletes/reactions**
  (so the AI never acts on stale text), **blob attachments** ↔ `files.upload`,
  and Quorum replies ↔ Slack threads.

## Packaging

Ship as a **separate package** (`@schady4/quorum-slack` / a `quorum bridge slack`
entry) so `@slack/bolt` stays out of the core bundle. The bridge depends on the
SDK's public surface (`RoomClient`, room crypto, control codecs) — it's a
reference consumer of "build on the bus," nothing privileged.
