#!/usr/bin/env node
// Quorum CLI entry point.
//
//   quorum host [--port <n>]                    start a relay/room server   (M1)
//   quorum join <room> [--as <handle>] [--relay <url>]   join a room        (M1)
//   quorum setup                                credential prompts          (M5)
//   quorum providers                            list installable providers
//   quorum --help                               usage

import { networkInterfaces, homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { providers, getProvider } from "./providers/index.js";
import { startRelay } from "./relay/server.js";
import { FileRelayStore } from "./relay/store.js";
import { deriveAuthToken } from "./net/crypto.js";
import { readManifest, streamFrames } from "./session/qdag.js";
import { FileRoomStore } from "./session/store.js";
import type { RoomClient } from "./net/client.js";
import { runTui } from "./tui/app.js";
import { spawnAgent } from "./agent/spawn.js";
import { createMergeResolver } from "./agent/merge.js";
import { loadCredentials, missingRequired, testProvider } from "./config/credentials.js";
import { runSetup } from "./config/setup.js";
import { style, box, Spinner, colorForHandle } from "./ui/style.js";

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
  const cmd = (s: string) => style.bold(s, process.stdout);
  console.log(`${style.brand("◇ quorum", process.stdout)} — multiplayer AI in your terminal

Usage:
  ${cmd("quorum host")} [--port <n>] [--key <secret>] [--open]
                                               Start a relay/room server (default 8787).
                                               Generates a room key unless --open.
  ${cmd("quorum join")} <room> [--as <handle>] [--relay <url>] [--key <secret>] [--provider <id>] [--model <id>] [--persist]
                                               Join a room (--persist keeps a local encrypted backup)
  ${cmd("quorum agent")} <room> [--as <handle>] [--key <secret>] [--provider <id>] [--model <id>] [--relay <url>]
                                               Seat an AI participant in a room
  ${cmd("quorum open")} <file.qdag> [--key <secret>] [--relay <url>] [--as <handle>] [--room <name>]
                                               Revive a saved session into a live room
  ${cmd("quorum setup")}                                 Configure model providers + keys (interactive)
  ${cmd("quorum setup --status")}                        Show which providers/keys are configured
  ${cmd("quorum setup --unset")} <provider>              Remove one provider's saved keys
  ${cmd("quorum setup --wipe")} [--yes]                  Delete all saved credentials
  ${cmd("quorum providers")}                             List installable model providers
  ${cmd("quorum --help")}                                Show this help

${style.dim("Try it locally: run `quorum host --open`, then `quorum join lobby --as you` in", process.stdout)}
${style.dim("one terminal and `quorum agent lobby --as claude` in another. Mention @claude to", process.stdout)}
${style.dim("talk to it (needs the provider's API key in the environment). Drop --open and", process.stdout)}
${style.dim("host prints a room key + invite to share with friends (see `quorum host`).", process.stdout)}
`);
}

async function listProviders(): Promise<void> {
  console.log(style.brand("◇ Installable model providers", process.stdout) + "\n");
  for (const p of providers) {
    const models = await p.listModels();
    const modelList = models.length ? models.map((m) => m.id).join(", ") : "(user-defined)";
    const creds = p.credentials.filter((c) => c.required).map((c) => c.key).join(", ") || "none";
    const configured = missingRequired(p, loadCredentials(p)).length === 0;
    const badge = configured ? style.ok("● configured", process.stdout) : style.dim("○ not configured", process.stdout);
    console.log(
      box([`${style.bold(p.label, process.stdout)}  ${style.dim(p.id, process.stdout)}`, `models: ${modelList}`, `needs:  ${creds}`, badge], {
        stream: process.stdout,
      }),
    );
    console.log("");
  }
  console.log(style.dim("Add a model vendor by dropping an adapter in src/providers/ — see providers/types.ts.", process.stdout));
}

/** This machine's non-internal IPv4 addresses — the ones a friend on the same
 *  network would dial. Empty on an odd network setup; we fall back to a
 *  placeholder then. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const ni of ifaces ?? []) {
      // Node reports family as "IPv4" (newer) or 4 (older).
      const v4 = ni.family === "IPv4" || (ni.family as unknown) === 4;
      if (v4 && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/** Where `quorum host --persist` keeps room logs + blobs by default. */
function defaultRelayStoreDir(): string {
  return pathJoin(homedir(), ".quorum", "relay");
}

async function host(args: string[]): Promise<void> {
  const { flags } = parse(args);
  const requested = Number(flags.port ?? 8787);
  // Secure by default: generate a room key unless the host passes one, or opts
  // out with --open for a keyless local relay.
  const open = "open" in flags;
  const key = open ? undefined : (flags.key || randomBytes(8).toString("base64url"));

  // Optional durability: --persist [dir] keeps the room logs + blobs on disk so
  // the relay reloads them on restart, even with nobody online. The stored bytes
  // are ciphertext — the relay still can't read them.
  const persistDir = "persist" in flags ? (typeof flags.persist === "string" && flags.persist ? flags.persist : defaultRelayStoreDir()) : undefined;
  const store = persistDir ? new FileRelayStore(persistDir) : undefined;

  // The relay only ever holds the derived auth token, never the room key — so it
  // can gate joins but can't decrypt the end-to-end-encrypted traffic.
  const spinner = new Spinner("starting relay");
  spinner.start();
  // Retention: keep only the last N messages per room (compacted while a room is
  // empty). Off unless a positive --retain is given.
  const maxOpsPerRoom = flags.retain ? Math.max(1, Number(flags.retain)) || undefined : undefined;

  const { port } = await startRelay({ port: requested, authToken: deriveAuthToken(key), verbose: true, store, maxOpsPerRoom });
  spinner.stop();
  if (persistDir) console.error(style.dim(`  persisting to ${persistDir}`));
  if (maxOpsPerRoom) console.error(style.dim(`  retaining the last ${maxOpsPerRoom} messages per room`));

  const ips = lanAddresses();
  const keyFlag = key ? ` --key ${key}` : "";

  const security = key
    ? `${style.ok("🔒 room key:")} ${style.bold(key)} · ${style.ok("end-to-end encrypted")}`
    : style.warn("⚠ open — no key, anyone who reaches it can join");

  // Kept out of the box on purpose: these are copy-paste shell commands, and a
  // couple run well past 80 columns — boxing them would force a hard wrap that
  // breaks mid-command on a normal terminal. The box holds only what's short
  // enough to always fit; commands get their own plain lines below it.
  console.error("");
  console.error(box([security], { title: `quorum relay · :${port}`, stream: process.stderr }));
  console.error("");
  console.error(style.bold("Same network (same Wi-Fi / LAN):"));
  if (ips.length) {
    for (const ip of ips) console.error(style.dim(`  quorum join <room> --relay ws://${ip}:${port}${keyFlag}`));
  } else {
    console.error(style.dim(`  quorum join <room> --relay ws://<this-machine-ip>:${port}${keyFlag}`));
  }
  console.error("");
  console.error(style.bold("Different networks (friends elsewhere):"));
  console.error(style.dim("  a private IP isn't reachable from outside, and this port is often"));
  console.error(style.dim("  firewalled — expose it with a tunnel for a public wss:// URL over 443:"));
  console.error(`  ${style.dim("ngrok http " + port)}  →  quorum join <room> --relay wss://<id>.ngrok.app${keyFlag}`);
  console.error(
    `  ${style.dim(`cloudflared tunnel --url http://localhost:${port}`)}  →  quorum join <room> --relay wss://<id>.trycloudflare.com${keyFlag}`,
  );
  console.error("");
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
  // With a provider, this seat can arbitrate semantic merge collisions.
  const resolver = flags.provider ? createMergeResolver({ providerId: flags.provider, model: flags.model }) : undefined;
  // --persist keeps a local, encrypted-at-rest copy of the room under
  // ~/.quorum/rooms, so you keep your history across restarts and can re-seed a
  // relay that lost its memory.
  const store = "persist" in flags ? new FileRoomStore() : undefined;
  runTui({ relayUrl, room, handle, key: flags.key, resolver, store });
}

async function agent(args: string[]): Promise<void> {
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
  const key = flags.key;

  const provider = getProvider(providerId);
  if (!provider) {
    console.error(`Unknown provider "${providerId}". Run \`quorum providers\` to list them.`);
    process.exit(1);
  }
  const creds = loadCredentials(provider);
  const missing = missingRequired(provider, creds);
  if (missing.length) {
    console.error(style.warn(`Warning: ${provider.id} is missing ${missing.join(", ")} — run \`quorum setup\` or set them as env vars, or the seat can't reply.`));
  } else {
    // Credentials are present but that doesn't mean they work (expired,
    // revoked, out of funds) — a seat that joins on a dead key just fails the
    // same way on every future @mention. Catch it here instead, once, before
    // the seat ever shows up in the room.
    const preflight = new Spinner(`checking ${provider.label} credentials`);
    preflight.start();
    const check = await testProvider(provider, creds);
    if (!check.ok) {
      preflight.stop(`${style.err("✗")} ${check.message}`);
      console.error(`Fix it:    quorum setup`);
      console.error(`Clear it:  quorum setup --unset ${provider.id}`);
      process.exit(1);
    }
    preflight.stop(`${style.ok(`✓ ${provider.label} is ready`)}`);
  }

  // One "thinking…" spinner per seat handle, live for exactly the window
  // between a trigger and its reply — a slow model stays visibly working
  // instead of looking indistinguishable from a stuck one.
  const thinking = new Map<string, Spinner>();
  const paint = colorForHandle(handle);

  spawnAgent({
    relayUrl,
    room,
    handle,
    key,
    providerId,
    model,
    onThinking: (h) => {
      const s = new Spinner(`${colorForHandle(h)(h)} thinking`);
      thinking.set(h, s);
      s.start();
    },
    onReply: (h, t) => {
      thinking.get(h)?.stop(`${colorForHandle(h)(h)} ▸ ${t}`);
      thinking.delete(h);
    },
    onError: (h, e) => {
      thinking.get(h)?.stop();
      thinking.delete(h);
      console.error(`${style.err(`[${h}]`)} ${e.message}`);
    },
  });
  console.error(`${style.ok("✓")} AI seat ${paint(`"${handle}"`)} joined ${style.bold(room)} via ${providerId}${model ? "/" + model : ""}. Mention @${handle} to talk to it.`);
  console.error(style.dim(`Delegate: "@${handle} delegate <name> using <provider>/<model> to <task>" spins up another seat.`));
}

async function open(args: string[]): Promise<void> {
  const { positionals, flags } = parse(args);
  const file = positionals[0];
  if (!file) {
    console.error("Usage: quorum open <file.qdag> [--key <secret>] [--relay <url>] [--as <handle>] [--room <name>] [--port <n>]");
    process.exit(1);
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    console.error(style.err(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }

  const key = flags.key;
  // Validate the key and read the room name up front (no message chunks loaded),
  // so a wrong/missing key fails here instead of after the window opens.
  let man;
  try {
    man = readManifest(raw, key);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    // The GCM failure is unreadable ("unable to authenticate data"); a wrong key
    // (or a tampered file) is the only way to get it, so say that instead.
    const friendly = /authenticate|bad decrypt|unsupported state/i.test(m) ? "wrong room key, or the file is corrupt" : m;
    console.error(style.err(`can't open this save: ${friendly}`));
    process.exit(1);
  }

  const room = flags.room ?? man.room;
  const handle = flags.as ?? `guest-${Math.random().toString(36).slice(2, 6)}`;
  const resolver = flags.provider ? createMergeResolver({ providerId: flags.provider, model: flags.model }) : undefined;

  // Bring the bond back to life: replay its frames into the room once connected.
  const seed = (client: RoomClient) => streamFrames(raw.split("\n"), { key }, (frames) => client.replay(frames));

  if (flags.relay) {
    // Revive into a relay someone is already running.
    runTui({ relayUrl: flags.relay, room, handle, key, resolver, onFirstOpen: seed });
    return;
  }

  // Default: host a fresh relay, seed the room, drop into it, and print the
  // invite so the people who were here can rejoin the revived room.
  const { port } = await startRelay({ port: Number(flags.port ?? 8787), authToken: deriveAuthToken(key) });
  const relayUrl = `ws://localhost:${port}`;
  const keyFlag = key ? ` --key ${key}` : "";
  const ips = lanAddresses();
  console.error("");
  console.error(box([`revived ${style.bold(room)} · ${man.roster.length} were here${key ? " · " + style.ok("🔒 encrypted") : ""}`], { title: `quorum open · :${port}`, stream: process.stderr }));
  console.error(style.bold("\nOthers can rejoin:"));
  for (const ip of ips.length ? ips : ["<this-machine-ip>"]) console.error(style.dim(`  quorum join ${room} --relay ws://${ip}:${port}${keyFlag}`));
  console.error("");
  runTui({ relayUrl, room, handle, key, resolver, onFirstOpen: seed });
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
    case "open":
      await open(rest);
      break;
    case "agent":
      await agent(rest);
      break;
    case "setup":
      await runSetup(rest);
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
