#!/usr/bin/env node
// Quorum CLI entry point.
//
//   quorum host [--port <n>]                    start a relay/room server   (M1)
//   quorum join <room> [--as <handle>] [--relay <url>]   join a room        (M1)
//   quorum setup                                credential prompts          (M5)
//   quorum providers                            list installable providers
//   quorum --help                               usage

import { providers, getProvider } from "./providers/index.js";
import { startRelay } from "./relay/server.js";
import { runTui } from "./tui/app.js";
import { spawnAgent } from "./agent/spawn.js";
import { loadCredentials, missingRequired } from "./config/credentials.js";

const [, , cmd, ...rest] = process.argv;

/** Minimal flag parser: --key value and bare positionals. */
function parse(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) flags[a.slice(2)] = args[++i] ?? "";
    else positionals.push(a);
  }
  return { positionals, flags };
}

function usage(): void {
  console.log(`quorum — multiplayer AI in your terminal

Usage:
  quorum host [--port <n>]                     Start a relay/room server (default 8787)
  quorum join <room> [--as <handle>] [--relay <url>]   Join a room
  quorum agent <room> [--as <handle>] [--provider <id>] [--model <id>] [--relay <url>]
                                               Seat an AI participant in a room
  quorum setup                                 Configure model providers + keys     (M5)
  quorum providers                             List installable model providers
  quorum --help                                Show this help

Try it locally: run \`quorum host\`, then \`quorum join lobby --as you\` in one
terminal and \`quorum agent lobby --as claude\` in another. Mention @claude to
talk to it (needs the provider's API key in the environment).
`);
}

async function listProviders(): Promise<void> {
  console.log("Installable model providers:\n");
  for (const p of providers) {
    const models = await p.listModels();
    const modelList = models.length ? models.map((m) => m.id).join(", ") : "(user-defined)";
    const creds = p.credentials.filter((c) => c.required).map((c) => c.key).join(", ") || "none";
    console.log(`  ${p.id.padEnd(10)} ${p.label}`);
    console.log(`  ${" ".repeat(10)} models: ${modelList}`);
    console.log(`  ${" ".repeat(10)} needs:  ${creds}\n`);
  }
  console.log("Add a model vendor by dropping an adapter in src/providers/ — see providers/types.ts.");
}

async function host(args: string[]): Promise<void> {
  const { flags } = parse(args);
  const port = Number(flags.port ?? 8787);
  await startRelay({ port, verbose: true });
  console.error(`Share this room by having friends run:  quorum join <room> --relay ws://<your-host>:${port}`);
  // startRelay keeps the process alive via the open server.
}

function join(args: string[]): void {
  const { positionals, flags } = parse(args);
  const room = positionals[0];
  if (!room) {
    console.error("Usage: quorum join <room> [--as <handle>] [--relay <url>]");
    process.exit(1);
  }
  const handle = flags.as ?? `guest-${Math.random().toString(36).slice(2, 6)}`;
  const relayUrl = flags.relay ?? "ws://localhost:8787";
  runTui({ relayUrl, room, handle });
}

function agent(args: string[]): void {
  const { positionals, flags } = parse(args);
  const room = positionals[0];
  if (!room) {
    console.error("Usage: quorum agent <room> [--as <handle>] [--provider <id>] [--model <id>] [--relay <url>]");
    process.exit(1);
  }
  const handle = flags.as ?? "claude";
  const providerId = flags.provider ?? "anthropic";
  const model = flags.model;
  const relayUrl = flags.relay ?? "ws://localhost:8787";

  const provider = getProvider(providerId);
  if (!provider) {
    console.error(`Unknown provider "${providerId}". Run \`quorum providers\` to list them.`);
    process.exit(1);
  }
  const missing = missingRequired(provider, loadCredentials(provider));
  if (missing.length) {
    console.error(`Warning: ${provider.id} is missing ${missing.join(", ")} — set them as env vars or the seat can't reply.`);
  }

  spawnAgent({
    relayUrl,
    room,
    handle,
    providerId,
    model,
    onReply: (h, t) => console.error(`${h} ▸ ${t}`),
    onError: (h, e) => console.error(`[${h}] ${e.message}`),
  });
  console.error(`AI seat "${handle}" joined ${room} via ${providerId}${model ? "/" + model : ""}. Mention @${handle} to talk to it.`);
  console.error(`Delegate: "@${handle} delegate <name> using <provider>/<model> to <task>" spins up another seat.`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "providers":
      await listProviders();
      break;
    case "host":
      await host(rest);
      break;
    case "join":
      join(rest);
      break;
    case "agent":
      agent(rest);
      break;
    case "setup":
      console.error("`quorum setup` arrives in M5 — for now, providers read keys from the environment.");
      process.exit(1);
      break;
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
