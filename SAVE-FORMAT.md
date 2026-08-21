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
  branch/merge DAG — with ids dropped (reassigned on revive);
- content hashes are **recomputed** on load, not stored.

What remains is interned (repeated authors, branch names, keys → a string
dictionary referenced by index), then gzipped, then sealed once.

### Container

A `.qdag` file is a portable JSON envelope:

```json
{ "magic": "QDAG1", "room": "lobby", "created": 1700000000000,
  "sealed": true, "body": "e1:<base64 AES-256-GCM>" }
```

- `body` is `base64(gzip(compact))`, and when `sealed`, that string is then
  AES-256-GCM sealed with the room key (`e1:` prefix — same scheme as the wire).
- `compact` is the interned/columnar form: `{ v, room, created, dict[], roster[],
  msgs: [authorIdx, text][], led: <compact ledger ops> }`.

Metadata (`room`, `created`, `sealed`) is plaintext in the envelope; the
conversation is only inside `body`. A sealed bond can't be opened without the
key.

### Revive ("bond it back")

`framesFrom(session)` regenerates op frames with **fresh ids** and a linear
`after`-chain for messages (original authors preserved) and fresh ledger-op
ids. Replaying those onto a new room reconstructs the same messages and the same
decision-DAG — the room is live again, and other members converge on it when
they rejoin. The room key gates revival: you need it to decode a sealed bond,
and the people who were on the DAG are exactly the people who had it.

### API

`encodeSave(session, key?) -> string` · `decodeSave(file, key?) -> Session` ·
`framesFrom(session) -> { ops, ledgerOps }` · `sessionFromClient(client) ->
Session`. Exported from `@schady4/quorum`.

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
