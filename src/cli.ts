#!/usr/bin/env node
// Quorum CLI entry point.
//
// Commands (filled in across milestones):
//   quorum host [--port 8787]     start a relay/room server            (M1)
//   quorum join <room> [--as me]  join a room from your terminal       (M1)
//   quorum setup                  first-run credential prompts         (M5)
//   quorum providers              list installable model providers     (works now)
//   quorum --help                 usage                                (works now)

import { providers } from "./providers/index.js";

const [, , cmd, ...rest] = process.argv;

function usage(): void {
  console.log(`quorum — multiplayer AI in your terminal

Usage:
  quorum host [--port <n>]      Start a relay/room server            (M1)
  quorum join <room> [--as <handle>]   Join a room                   (M1)
  quorum setup                  Configure model providers + keys     (M5)
  quorum providers              List installable model providers
  quorum --help                 Show this help
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

async function main(): Promise<void> {
  switch (cmd) {
    case "providers":
      await listProviders();
      break;
    case "host":
    case "join":
    case "setup":
      console.error(`\`quorum ${cmd}\` is not implemented yet — see ROADMAP milestones in the multiplayer-ai repo.`);
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
  void rest;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
