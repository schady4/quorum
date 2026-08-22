// Proof of the torchbearer: who is the last human out (over the wire, agents
// don't hold the torch), the save filename/hint helpers, and that a saved
// session file round-trips. Run with `npm run test:torchbearer`.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { AgentSeat } from "../src/agent/seat.js";
import { humansAmong, isLastHuman, saveFilename, reviveHint, saveSessionToDir } from "../src/session/torchbearer.js";
import { decodeSave, type Session } from "../src/session/qdag.js";

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
function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

// --- pure logic --------------------------------------------------------------
function pure(): void {
  check("humansAmong drops the agents", eq(humansAmong(["ada", "claude", "bob"], ["claude"]), ["ada", "bob"]));
  check("last human when only agents remain besides you", isLastHuman(["ada", "claude"], ["claude"], "ada"));
  check("not the last human when another human is present", !isLastHuman(["ada", "bob", "claude"], ["claude"], "ada"));
  check("an agent never holds the torch", !isLastHuman(["ada", "claude"], ["claude"], "claude"));
  check("saveFilename is safe + timestamped", /^lobby-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.qdag$/.test(saveFilename("lobby", new Date("2026-08-22T12:34:56Z"))));
  const hint = reviveHint("/x/lobby.qdag", true);
  check("reviveHint shows the path and the key for a sealed save", hint.includes("/x/lobby.qdag") && hint.includes("quorum open") && hint.includes("--key"));
  check("reviveHint omits the key for an open save", !reviveHint("/x/lobby.qdag", false).includes("--key"));
}

// --- save file round-trips ---------------------------------------------------
function fileRoundTrip(): void {
  const session: Session = {
    room: "lobby",
    created: 1700000000000,
    roster: ["ada", "claude"],
    messages: [
      { author: "ada", text: "final thoughts before we go" },
      { author: "claude", text: "saved for next time" },
    ],
    ledger: [{ type: "fork", branches: ["A", "B"] }],
  };
  const dir = mkdtempSync(join(tmpdir(), "quorum-torch-"));

  const openPath = saveSessionToDir(session, undefined, dir);
  check("an open save round-trips from disk", eq(decodeSave(readFileSync(openPath, "utf8")), session));

  const sealedPath = saveSessionToDir(session, "s3cret", dir);
  check("a sealed save round-trips with the key", eq(decodeSave(readFileSync(sealedPath, "utf8"), "s3cret"), session));
  check("a sealed save on disk is ciphertext", !readFileSync(sealedPath, "utf8").includes("final thoughts"));
}

// --- over the wire: agents don't hold the torch ------------------------------
async function overTheWire(): Promise<void> {
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  const ada = new RoomClient(url, "lobby", "ada"); // human (default)
  ada.on("error", () => {});
  ada.connect();
  await nextOpen(ada);

  const claude = new AgentSeat({ relayUrl: url, room: "lobby", handle: "claude", respond: async () => "" });
  claude.start();
  await nextOpen(claude.roomClient);

  await waitUntil(() => ada.participants.includes("claude"));
  check("the relay reports the AI seat as an agent", eq(ada.agents, ["claude"]));
  check("ada is the last human even with an AI seat present", isLastHuman(ada.participants, ada.agents, "ada"));

  const bob = new RoomClient(url, "lobby", "bob"); // second human
  bob.on("error", () => {});
  bob.connect();
  await nextOpen(bob);
  await waitUntil(() => ada.participants.includes("bob"));
  check("ada is not the last human once bob joins", !isLastHuman(ada.participants, ada.agents, "ada"));

  claude.close();
  ada.close();
  bob.close();
  await relay.close();
}

async function main(): Promise<void> {
  pure();
  fileRoundTrip();
  await overTheWire();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
