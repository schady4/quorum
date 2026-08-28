# Getting Started

## Install

Published to npm (scoped, because `quorum` was taken):

```bash
npx @schady4/quorum --help
# or
npm install -g @schady4/quorum
```

## Configure providers

```bash
npx @schady4/quorum setup
```

`setup` walks the providers, asks which to enable, and prompts for each one's
keys (secrets masked). Values are written to `~/.quorum/credentials.json`
(owner-only) and sent straight to each provider — nothing is collected for
providers you don't use, and nothing leaves your machine except the API calls
themselves. A one-off `ANTHROPIC_API_KEY=… quorum agent …` env var overrides the
stored value.

Every key you enter is **live-checked** with one minimal real call right there in
the prompt, so a bad or out-of-funds key is caught immediately — not the first
time an AI seat tries to use it. `quorum agent` runs the same check on start, so a
seat with a dead key refuses to join instead of failing silently on every future
`@mention`.

## Managing saved keys

You don't have to re-run the whole wizard:

```bash
quorum setup --status             # what's configured, per provider (masked)
quorum setup --unset anthropic    # drop just one provider's keys
quorum setup --wipe               # delete everything and start clean
```

Inside the interactive prompt, typing `-` for a saved value clears it.

## First run (one machine, three terminals)

```bash
quorum host --open                    # terminal 1 — the relay (keyless, local use)
quorum join lobby --as ada            # terminal 2 — you
ANTHROPIC_API_KEY=sk-... \
  quorum agent lobby --as claude      # terminal 3 — an AI seat
```

Type in your seat; both windows converge. Say `@claude …` to talk to the AI — it
reads the shared stream and replies into it. A late joiner catches up from the
relay's op log.

Working from a clone instead of an install? `npm run build` first, then run
`node dist/cli.js …` — or `npm run dev -- …` straight from source.

**Next:** [CLI Reference](CLI-Reference) · [Using a Room](Using-a-Room) ·
[Hosting & Sharing](Hosting-and-Sharing)
