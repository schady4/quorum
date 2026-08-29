# CLI Reference

```
quorum host   [--port <n>] [--key <secret>] [--open] [--persist [dir]] [--retain <n>]   Relay
quorum join   <room> [--as <h>] [--relay <url>] [--key <s>] [--provider <id>] [--persist]  Join
quorum invite <room> --relay <url> [--key <s>]                                          Invites
quorum agent  <room> [--as <h>] [--provider <id>] [--model <id>] [--key <s>]            AI seat
quorum open   <file.qdag> [--key <s>] [--relay <url>] [--as <h>] [--room <name>]        Revive a save
quorum setup                                        Configure providers + keys (interactive)
quorum setup  --status | --unset <provider> | --wipe    Inspect / remove / reset credentials
quorum providers                                    List installable providers
quorum bridge slack                                 Relay a Slack channel ⟷ a Quorum room (Socket Mode)
quorum --help                                       Usage
```

## host

Starts a relay/room server (default port `8787`). **Secure by default**: it
generates a shared room key and prints a ready invite line. Flags:

- `--port <n>` — listen port.
- `--key <secret>` — use your own room key instead of a generated one.
- `--open` — keyless, unencrypted local relay (no key; anyone who reaches it can join).
- `--persist [dir]` — persist op logs + blobs to disk (default `~/.quorum/relay`), reloaded on restart.
- `--retain <n>` — keep only the last _n_ messages per room (compacted while the room is empty).

The relay is configured with only the derived **auth token**, never the room
key — so it gates joins but can't read the traffic. See
[Hosting & Sharing](Hosting-and-Sharing) for the full model.

## join

Join a room from a relay. `--as` sets your handle, `--relay` the ws(s):// URL,
`--key` the room secret, `--provider`/`--model` seat your own AI alongside you,
`--persist` keeps a local encrypted backup that restores on restart.

## invite

Print two ready-to-send invites for a room — a **private** one (DM / email, with
the key) and a **public / social** one (Twitter/X, Mastodon) that **never
includes the key** (a room key both gates joins and decrypts the chat, so posting
it publicly would hand anyone the room). `host` points you at this in its output.

```bash
quorum invite lobby --relay wss://abc123.ngrok.app --key hunter2
```

## agent

Seat an AI participant in a room. Model-agnostic:
`--provider anthropic|openai|meta|kimi|local` selects the vendor, `--model` picks
the model. Credentials come from `quorum setup` or a `KEY=… quorum agent …`
environment override. Runs its key's live-check on start.

## open

Revive a saved `.qdag` session into a live room — see
[Saving & Reviving](Saving-and-Reviving).

## setup / providers

Configure and inspect provider credentials — see
[Getting Started](Getting-Started) — and list installable providers with their
models and required keys.

## bridge slack

Relay one Slack channel ⟷ one Quorum room, bidirectionally, over Slack **Socket
Mode** (no public URL). Config is read from the environment
(`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL`, `QUORUM_ROOM`, plus
`QUORUM_RELAY` / `QUORUM_KEY`); `@slack/bolt` is an optional peer dependency you
install on the bridge host (`npm i @slack/bolt`). The room key stays on the host
and is **never sent to Slack**; `/quorum key …` is refused by design. Full setup,
scopes, and the identity/durability model are on the
[Slack Bridge](Slack-Bridge) page.

## In-window keys

**Enter** sends · **↑/↓** recall previous messages · **←/→ · Home/End** move the
cursor · **PgUp/PgDn** scroll history · **Esc** quits. The message pane is bounded
to the terminal and stays pinned to the newest message unless you scroll up.

**Next:** [Using a Room](Using-a-Room)
