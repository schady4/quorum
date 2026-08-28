# Providers

Quorum is model-agnostic. Claude, OpenAI, Meta/Llama, Kimi, and local /
open-source models all plug in behind one adapter. OpenAI, Meta/Llama, Kimi, and
local servers share one OpenAI-compatible HTTP path, so **any OpenAI-compatible
endpoint works too**.

Pick the vendor and model when you seat an AI:

```bash
quorum agent lobby --provider anthropic --model claude-sonnet-5
# or, from inside a room:
/agent claude --provider openai --model gpt-5
```

List what's installable (with each one's models and required keys):

```bash
quorum providers
```

## Add a model provider

Quorum is extensible at one seam: the **provider adapter**. To add a vendor,
implement
[`ProviderAdapter`](https://github.com/schady4/quorum/blob/main/src/providers/types.ts)
in a new file under `src/providers/` and register it in `src/providers/index.ts`.
The router, the room protocol, and the TUI never change — that's the whole point
of the interface.

## Repo layout

```
src/
  core/        CRDT live surface + DAG ledger
  relay/       self-hostable room server / chat backbone
  tui/         Ink terminal chat window
  router/      multi-model routing + delegation
  providers/   the model adapters — the extensibility surface
  cli.ts       command entry point
```

## Develop

```bash
npm install
npm run dev -- providers     # run the CLI from source
npm run build                # compile to dist/
npm run typecheck
npm run test:all             # the full suite
```

See [Publishing to npm](Publishing) for the release process.
