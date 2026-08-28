# Hosting & Sharing

## Secure by default

Drop `--open` and `quorum host` generates a shared room key and prints a
ready-to-send invite line (`… --relay … --key <secret>`). From that one key each
client derives, independently, a relay **auth token** and an **encryption key**.
The relay is configured with only the token — a one-way derivation — so it gates
joins but can't read the traffic: chat and decision values are sealed with
**AES-256-GCM** end-to-end, and the relay is a **zero-knowledge mailbox**.
Structural metadata (who's present, message ordering, branch names and decision
keys) stays in the clear so convergence still works.

Pass your own key with `--key`, or run a keyless, unencrypted local relay with
`--open`.

## Same network (Wi-Fi / LAN)

Friends run the LAN invite `host` printed:

```bash
quorum join <room> --relay ws://<your-lan-ip>:8787 --key <key>
```

## Different networks (friends elsewhere)

A private IP isn't reachable from outside, and port 8787 is often firewalled — so
expose the relay through a **tunnel**, which also gives you a public `wss://` URL
over 443 that restrictive networks allow. `host` prints the exact commands; for
example:

```bash
ngrok http 8787
#   → quorum join <room> --relay wss://<id>.ngrok.app --key <key>
cloudflared tunnel --url http://localhost:8787
#   → quorum join <room> --relay wss://<id>.trycloudflare.com --key <key>
```

Either way the room is end-to-end encrypted with that key, so neither the tunnel
nor the relay ever sees your messages — only people holding the key do. Drop the
Wi-Fi and clients reconnect on their own.

## One-line invites

`quorum invite <room> --relay <url> [--key <secret>]` prints two ready-to-send
messages:

- a **private** one (DM / email) that **includes the key**, and
- a **public** one (Twitter/X, Mastodon) that deliberately **withholds** it.

Because a room key both gates joins *and* decrypts the chat, posting it publicly
would hand anyone the room — so the public invite never contains it and tells
people to ask for the key privately. `quorum host` points you at this command
under **Share it:**.

## Persistence & retention

- `--persist [dir]` — the relay keeps op logs + blobs on disk and reloads them on
  restart (so a relay can recover its memory). Any persisting **client** is also a
  backup and can re-seed a relay that lost its state.
- `--retain <n>` — bound a room to the last _n_ messages, compacted while the room
  is empty.

**Next:** [Saving & Reviving](Saving-and-Reviving)
