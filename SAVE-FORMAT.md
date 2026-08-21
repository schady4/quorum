# Quorum session storage

Two complementary mechanisms, both building on the fact that a room is an
append-only op log. See also [PROTOCOL.md](./PROTOCOL.md).

## The `.qdag` bond — a portable, revivable save

A **bond** binds a room's roster and its complete decision-DAG (branches,
merges, provenance) together with the message thread into one small file that
anyone holding it *and the room key* can revive into a live room.

### Why it's small

A live room's op log is fat with CRDT plumbing — op ids, causal `after`
pointers, `clientId` prefixes — that exists only so concurrent edits converge.
A finished save has nothing to merge against, so a bond keeps only the
materialized result and drops the plumbing:

- messages in **converged order** (`[author, text]`), no ids/pointers;
- the **ledger op sequence** (fork/edit/merge), which replays to the exact
  branch/merge DAG — with ids dropped (reassigned on revive).

Each chunk is gzipped and sealed; gzip dedupes the repeated authors within it.

### Container — chunked NDJSON

A `.qdag` file is newline-delimited JSON so it **streams**: read/write a line at
a time, never the whole file. The decision-DAG (ledger) is tiny and lives whole
in the manifest; only the unbounded **message stream** is chunked.

```
line 1  manifest  { "magic":"QDAG2", "room", "created", "sealed", "roster":[…], "ledger": "<body>" }
line 2… chunk     { "i":0, "n":<count>, "hash":"<sha256/16>", "body": "<body>" }
```

- `<body>` = `base64(gzip(payload))`, then, when `sealed`, AES-256-GCM sealed
  with the room key (`e1:` prefix — same scheme as the wire). The manifest's
  `ledger` body wraps the ledger ops; each chunk body wraps a slice of
  `[author, text]` messages.
- `roster`, `room`, `created` are plaintext metadata; the conversation and the
  decision values are only inside sealed `body` fields. A sealed bond can't be
  opened without the key.
- Each chunk carries a `hash` of its `body`; decode verifies it and rejects a
  tampered or truncated chunk.

**Bounded memory at every step.** Encode seals one chunk at a time; decode/revive
opens one chunk at a time. A gigabyte-class session never gzips, seals, or loads
as a single blob. A small chat is just `manifest + one chunk`. Chunks are also
the natural unit for feeding history back to a model within a context window.

### Revive ("bond it back")

`framesFrom(session)` (in-memory) or `streamFrames(lines, …)` (bounded memory)
regenerate op frames with **fresh ids** — a linear `after`-chain for messages
(original authors preserved) and fresh ledger-op ids. Replaying those onto a new
room reconstructs the same messages and the same decision-DAG; the room is live
again, and other members converge when they rejoin. The room key gates revival:
you need it to open a sealed bond, and the people who were on the DAG are exactly
the people who had it.

### API

`encodeSave(session, key?) -> string` and `decodeSave(file, key?) -> Session`
(whole, for saves that fit in memory) · `writeSave(session, emit, opts)` and
`streamFrames(lines, opts, emit)` (streaming, for any size) · `framesFrom(session)`
· `sessionFromClient(client)`. `opts.maxChunkBytes` tunes the chunk size
(default ~4 MB). All exported from `@schady4/quorum`.

## The `RoomStore` — continuous per-client durability

A client that holds a `RoomStore` writes every frame it sees and reloads them on
start, so it survives restarts and can push its log back to **re-seed a relay**
that lost its memory. Frames are stored **exactly as they crossed the wire**
(sealed), so the archive is encrypted at rest — plaintext is never persisted.

```ts
interface RoomStore {
  load(room: string): StoredFrame[];        // on connect -> apply before welcome
  append(room: string, frame: StoredFrame): void; // on every op -> durable
}
```

Backends: `FileRoomStore` (append-only JSONL under `~/.quorum/rooms/`) for
Node/desktop, `MemoryRoomStore` for tests; an IndexedDB backend for
browser/mobile is a later phase. The client depends on the interface, not the
backend.
