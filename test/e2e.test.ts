// Integration proof of end-to-end encryption: chat and ledger content crosses
// the wire as ciphertext (a raw frame observer, admitted with only the auth
// token, never sees plaintext), while a peer holding the room key reads it back
// in the clear. The relay is a zero-knowledge mailbox. Offline; no model keys.
// Run with `npm run test:e2e`.

import { WebSocket } from "ws";
import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { deriveAuthToken } from "../src/net/crypto.js";
import { encode, decode, type ServerMsg } from "../src/net/protocol.js";
import type { Entry } from "../src/core/crdt.js";

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

const SECRET = "correct horse battery";
const CHAT = "launch the thing on friday";

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0, authToken: deriveAuthToken(SECRET) });
  const url = `ws://localhost:${relay.port}`;

  // A raw frame observer: it presents the auth token to pass the gate, but does
  // no decryption — so it sees exactly what travels on the wire (what the relay
  // stores). Stands in for a curious relay operator, who has only the token.
  const wireFrames: ServerMsg[] = [];
  const raw = new WebSocket(url);
  raw.on("message", (d: Buffer) => wireFrames.push(decode(d.toString()) as ServerMsg));
  await new Promise<void>((res) => raw.on("open", () => res()));
  raw.send(encode({ t: "hello", room: "vault", handle: "wire", auth: deriveAuthToken(SECRET) }));
  await wait(120);

  const alice = new RoomClient(url, "vault", "alice", SECRET);
  alice.on("error", () => {});
  alice.connect();
  await nextOpen(alice);
  await wait(120);

  // --- Chat: ciphertext on the wire, plaintext for a peer with the key. -----
  alice.send(CHAT);
  const gotOp = await waitUntil(() => wireFrames.some((m) => m.t === "op" && m.op.type === "insert" && m.op.author === "alice"));
  const chatOp = wireFrames.find((m) => m.t === "op" && m.op.type === "insert" && m.op.author === "alice");
  const wireValue = chatOp && chatOp.t === "op" && chatOp.op.type === "insert" ? chatOp.op.value : "";
  check("chat op reached the wire", gotOp);
  check("wire value is sealed, not plaintext", wireValue.startsWith("e1:") && !wireValue.includes(CHAT), `wire="${wireValue.slice(0, 24)}…"`);

  const bob = new RoomClient(url, "vault", "bob", SECRET);
  bob.on("error", () => {});
  bob.connect();
  await nextOpen(bob);
  const bobReads = await waitUntil(() => bob.entries().some((e: Entry) => e.author === "alice" && e.value === CHAT));
  check("a peer with the key reads plaintext", bobReads, bob.entries().map((e) => `${e.author}:${e.value}`).join(" | "));

  // --- Ledger: decision values are sealed on the wire too. ------------------
  alice.fork(["A", "B"]);
  alice.setDecision("A", "owner", "ada");
  const gotEdit = await waitUntil(() =>
    wireFrames.some((m) => m.t === "ledger" && m.op.type === "edit" && m.op.key === "owner"),
  );
  const editFrame = wireFrames.find((m) => m.t === "ledger" && m.op.type === "edit" && m.op.key === "owner");
  const editWire = editFrame && editFrame.t === "ledger" && editFrame.op.type === "edit" ? editFrame.op.value : "";
  check("ledger edit reached the wire", gotEdit);
  check("ledger value is sealed, key stays plaintext", editWire.startsWith("e1:") && editWire !== "ada", `wire="${editWire.slice(0, 24)}…"`);

  const bobSees = await waitUntil(() => bob.ledger.branches.get("A")?.owner === "ada");
  check("a peer decrypts the decision value", bobSees, JSON.stringify(bob.ledger.branches.get("A") ?? {}));

  raw.close();
  alice.close();
  bob.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
