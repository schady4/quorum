# Quorum room protocol

The contract every edge speaks — a surface (terminal, desktop, mobile), a bridge
(Slack, Discord, Twitch), or an external agent. It is deliberately small: the
relay moves opaque, deduped ops; all convergence and all decryption happen on the
replicas. Anything that speaks this protocol and holds the room key is a **seat**,
indistinguishable on the bus from any other.

The reference implementation of both ends is exported from
[`@schady4/quorum`](./src/sdk.ts) (`startRelay`, `RoomClient`, `encode`/`decode`,
`roomCrypto`, …). This document is the wire-level contract those build on.

## Transport

One WebSocket per client. Every frame is a single newline-free JSON object
(`encode`/`decode`). Frames are tagged by a `t` field.

## Handshake

1. Client → server **`hello`**: `{ t, room, handle, auth?, clientId? }`
   - `auth` — the room auth token (see [Auth](#auth-one-secret-two-keys)); omitted for an open relay.
   - `clientId` — a stable per-client id, unchanged across that client's reconnects.
2. Server → client, on success **`welcome`**: `{ t, room, participants, ops, ledgerOps, checkpointOps }`
   — the full replay logs so a joiner (or rejoiner) catches up.
3. Server → client, on refusal **`denied`**: `{ t, reason }`, then the socket closes.
   A join is refused for a bad/missing auth token, or a handle already held by a
   different live client. `denied` is terminal — clients must not retry it.

## Frames after joining

Either direction unless noted:

| `t`          | payload                    | meaning |
|--------------|----------------------------|---------|
| `op`         | `{ op }`                   | one chat-surface CRDT op |
| `ledger`     | `{ op }`                   | one decision-ledger op (fork / edit / merge) |
| `checkpoint` | `{ op }`                   | a seat's progress marker |
| `presence`   | `{ participants }`         | server → clients: the roster changed |
| `signal`     | `{ sig, from, data? }`     | an **ephemeral** signal (typing, read receipt) |
| `register-push` | `{ token }`             | client → server: a device push token for this member |

The relay appends each `op`/`ledger`/`checkpoint` to the room's log (deduped by
`op.id`) and broadcasts it to the other clients. It never inspects payload
content.

### Signals (ephemeral)

A `signal` is fanned out to the other members and then **forgotten** — never
appended to a log, never in a `welcome` catch-up, never in a saved bond. It's the
channel for transient, high-frequency metadata that must not bloat the durable
history: typing state, read receipts. `sig` names the kind, `from` is the
sender's handle, `data` is kind-specific and travels in the clear (structural
metadata, like op ids and handles, is never hidden — see below).

## Blob channel (large attachments)

Alongside the WebSocket, the relay serves a content-addressed blob store over
HTTP on the same host/port, so large attachments don't have to be inlined into
messages (which would bloat the op log):

| method + path              | meaning |
|----------------------------|---------|
| `PUT /blob/:room/:id`      | store sealed bytes (idempotent; `id` = sha256 of the ciphertext) |
| `GET /blob/:room/:id`      | fetch the sealed bytes |

Both require the room auth token in an **`x-quorum-auth`** header (the same gate
as the socket). The client seals a file's bytes with the room key **before**
upload, so the relay stores only opaque ciphertext keyed by its own hash — the
same zero-knowledge property as the message stream. A chat message then carries
just a small reference `{ blobId, name, mime, size }`; a receiver `GET`s the
ciphertext and opens it with the room key. Per-blob and per-room size caps are
configured on the relay (`maxBlobBytes`, `maxRoomBlobBytes`).

## Push notifications (disconnected members)

A client sends `register-push` with its device push token after joining; the
relay keeps it keyed by handle + room, across reconnects. When a chat `op`
arrives, the relay notifies every registered handle that is **not currently
connected** (and never the sender), rate-limited per handle.

The push is **content-free by construction**: the relay is zero-knowledge, so it
can only send metadata it already sees — the sender's handle and the room name
(`{ title: room, body: "<handle> sent a message", data: { room } }`), never the
message text. Delivery defaults to Expo's push API and is injectable
(`sendPush`) for a different gateway or for tests; set `push: false` to disable
outbound push entirely.

### Chat ops (RGA)

`{ type: "insert", id, after, value, author }` — a message is one element in a
replicated growable array. `after` is the id of the element it follows;
concurrent inserts at the same point order deterministically by `id`. `apply` is
idempotent (dedupe by `id`), so replaying the log converges. `value` is the
message text, **sealed** when the room is keyed (see below). `author` is the
seat's handle (plaintext — presence is not hidden).

### Ledger ops

- `{ type: "fork", id, branches }`
- `{ type: "edit", id, branch, key, value, author }`
- `{ type: "merge", id, branches: [a, b], resolved, author, viaArbitration, rationale? }`

The decision-state is a small key/value store; branches diverge and reconcile by
a deterministic three-way merge. A genuine collision (same key, incompatible
values) is resolved once by an AI arbiter at the initiator, and the resolved
values ride inside the `merge` op so every replica lands identically. `edit.value`
and each value in `merge.resolved` are **sealed** when keyed; branch names and
keys stay plaintext (the merge compares keys).

### Checkpoints

`{ id, seat, handled }` — seat `seat` has finished handling chat entry `handled`.
Replayed in `welcome`, so a reconnecting seat resumes instead of re-acting.

## Auth: one secret, two keys

Friends share one secret **K** (the room key). Each client derives, with no
coordination: `master = scrypt(K)`, then via HKDF an **auth token**
(room-independent) and a per-room **encryption key**.

- The client sends only the **auth token** in `hello`.
- The relay is configured with only the auth token and compares it in constant
  time. It never sees K or the encryption key, so it **cannot decrypt** — it is a
  zero-knowledge mailbox.
- An empty/absent auth token = an open, unencrypted relay.

`deriveAuthToken(K)` and `roomCrypto(K, room)` produce these.

## End-to-end encryption

When keyed, content is sealed with **AES-256-GCM** before it touches the wire.
The sealed form is a string:

```
"e1:" + base64( iv(12 bytes) | authTag(16 bytes) | ciphertext )
```

Sealed: chat `value`, ledger `edit.value`, ledger `merge.resolved` values.
Plaintext (structural, so the relay can order/dedupe and the merge can run):
op ids, `after` pointers, author handles, branch names, decision keys, presence.
A reader without K is refused at the gate, so it never receives ciphertext.

## Liveness

- The relay pings each socket on a heartbeat and terminates one that misses a
  beat (dead sockets leave the roster promptly, freeing the handle).
- The client runs its own heartbeat and, on a silent relay (no traffic for an
  interval), terminates and reconnects with backoff.
- Handle-uniqueness uses `clientId`: the same client reconnecting reclaims its
  handle; a different live client claiming a held handle is refused.

## Versioning

Sealed blobs are versioned by the `e1:` prefix. New frame types and op types may
be **added**; existing shapes are stable. Unknown frame types are ignored by
conforming relays and clients.
