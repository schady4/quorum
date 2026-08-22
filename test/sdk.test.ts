// Proof that the public SDK barrel is sufficient to build an edge on the bus,
// importing ONLY from ../src/sdk.js — no reaching into internals, no CLI, no
// TUI. If this compiles and runs, a desktop/mobile surface, a bridge, or an
// external agent can be built the same way. Run with `npm run test:sdk`.

import { startRelay, RoomClient, AgentSeat, deriveAuthToken, roomCrypto } from "../src/sdk.js";
import type { Entry, Responder } from "../src/sdk.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));
async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await wait(25);
  }
  return cond();
}

async function main(): Promise<void> {
  // The crypto contract is exported and usable on its own.
  const token = deriveAuthToken("hunter2");
  check("deriveAuthToken yields a non-empty token", token.length > 0);
  check("roomCrypto seals and opens a round-trip", roomCrypto("hunter2", "lobby").dec(roomCrypto("hunter2", "lobby").enc("hi")) === "hi");

  // Host a bus and join it as a human/bridge-style seat — SDK only.
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  const human = new RoomClient(url, "lobby", "ada");
  human.on("error", () => {});
  human.connect();
  await nextOpen(human);

  // Seat an agent with a fake responder — the same primitive a model seat or an
  // external-agent bridge uses.
  const echo: Responder = async (entries: Entry[], self: string) => {
    const last = entries[entries.length - 1];
    return `${self} heard: ${last?.value ?? ""}`;
  };
  const agent = new AgentSeat({ relayUrl: url, room: "lobby", handle: "echo", respond: echo });
  agent.start();
  await nextOpen(agent.roomClient);
  await wait(120);

  human.send("@echo hello bus");
  const replied = await waitUntil(() => human.entries().some((e: Entry) => e.author === "echo" && e.value.includes("hello bus")));
  check("an agent seat built from the SDK answers on the bus", replied, human.entries().map((e) => `${e.author}:${e.value}`).join(" | "));

  agent.close();
  human.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
