# Saving & Reviving

Two storage mechanisms sit on the same op-log substrate (details in
[SAVE-FORMAT.md](https://github.com/schady4/quorum/blob/main/SAVE-FORMAT.md)),
both encrypted at rest with the room key.

## `RoomStore` — continuous durability

Wired into `RoomClient` and switched on with `quorum join … --persist`. A
persisting client keeps every (sealed) frame it sees, **restores its history on
restart** (even before the relay answers, or fully offline), and **re-seeds a
relay** that lost its memory. Any client becomes a backup — no server database
needed.

## The `.qdag` bond — a portable, revivable save

A small, portable, *revivable* save. It binds the roster and the complete
decision-DAG (branches, merges, provenance) with the message thread; anyone
holding the file **and the room key** can revive it into a live room. It's small
because a finished save drops the live-only CRDT plumbing and keeps just the
replayable result, interned + gzipped + sealed.

**Torchbearer save.** When the last human quits a non-empty room (AI seats don't
hold the torch), the chat window offers to save it before it's gone — `[y/N]`. Say
yes and it writes a sealed `.qdag` under `~/.quorum/saves/` and prints how to
bring it back.

## Revive

```bash
quorum open <file.qdag> --key <key>
```

Brings a saved room back to life: it hosts a fresh relay, replays the bond
(streamed, so even a huge save stays bounded-memory), drops you into the room with
the full history and the same decision-DAG — **original authors preserved** — and
prints an invite so the people who were there can rejoin. Point it at an existing
relay with `--relay`.

Everything's exported from the SDK too (`RoomStore`/`FileRoomStore`,
`encodeSave`/`decodeSave`/`framesFrom`/`streamFrames`, `isLastHuman`/
`saveSessionToDir`, `RoomClient.replay`).

**Next:** [Build on the Bus](Build-on-the-Bus)
