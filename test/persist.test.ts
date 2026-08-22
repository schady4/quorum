// Headless proof of the two storage mechanisms: the .qdag bond (encode/decode/
// revive, sealed-at-rest, small) and the RoomStore (durable append/load). No
// terminal, no network. Run with `npm run test:persist`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSave, decodeSave, writeSave, framesFrom, streamFrames, sessionFromClient, type Session } from "../src/session/qdag.js";
import { MemoryRoomStore, FileRoomStore } from "../src/session/store.js";
import { createSurface } from "../src/core/crdt.js";
import { Ledger } from "../src/core/ledger.js";
import type { Entry } from "../src/core/crdt.js";
import type { LedgerOp } from "../src/core/ledger.js";

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

const session: Session = {
  room: "lobby",
  created: 1700000000000,
  roster: ["ada", "claude", "bob"],
  messages: [
    { author: "ada", text: "let's plan the launch" },
    { author: "claude", text: "what's the target date?" },
    { author: "bob", text: "@claude summarize the thread" },
    { author: "claude", text: "owner ada, two branches open" },
  ],
  ledger: [
    { type: "fork", branches: ["A", "B"] },
    { type: "edit", branch: "A", key: "owner", value: "ada", author: "ada" },
    { type: "edit", branch: "B", key: "deadline", value: "monday", author: "bob" },
    { type: "merge", branches: ["A", "B"], resolved: { owner: "ada", deadline: "monday" }, author: "claude", viaArbitration: true, rationale: "kept both" },
  ],
};

function main(): void {
  // --- bond round-trip, open and sealed ------------------------------------
  check("open bond round-trips exactly", eq(decodeSave(encodeSave(session)), session));

  const sealed = encodeSave(session, "s3cret");
  check("sealed bond round-trips with the key", eq(decodeSave(sealed, "s3cret"), session));

  let noKeyThrew = false;
  try {
    decodeSave(sealed);
  } catch {
    noKeyThrew = true;
  }
  check("a sealed bond can't be opened without the key", noKeyThrew);

  let wrongKeyThrew = false;
  try {
    decodeSave(sealed, "wrong");
  } catch {
    wrongKeyThrew = true;
  }
  check("a sealed bond rejects the wrong key", wrongKeyThrew);

  // --- sealed at rest: the wire/relay/disk never sees plaintext -------------
  const sealedLines = sealed.split("\n");
  const man = JSON.parse(sealedLines[0]) as { sealed: boolean; ledger: string; roster: string[] };
  const chunk0 = JSON.parse(sealedLines[1]) as { body: string };
  check(
    "sealed bond is encrypted at rest (manifest ledger + chunks)",
    man.sealed && man.ledger.startsWith("e1:") && chunk0.body.startsWith("e1:") && !sealed.includes("plan the launch"),
  );

  // --- DAG fidelity: the merge (provenance + resolution) survives -----------
  const back = decodeSave(encodeSave(session));
  const merge = back.ledger.find((o) => o.type === "merge");
  check(
    "the decision-DAG (branches, merge, provenance) survives",
    !!merge && merge.type === "merge" && merge.viaArbitration === true && merge.rationale === "kept both" && eq(merge.resolved, { owner: "ada", deadline: "monday" }),
  );

  // --- revive: frames from a bond rebuild the same live room ----------------
  const { ops, ledgerOps } = framesFrom(session);
  const surface = createSurface();
  for (const op of ops) surface.apply(op);
  const revivedMsgs = surface.entries().map((e: Entry) => ({ author: e.author, text: e.value }));
  check("revive rebuilds messages in order, keeping original authors", eq(revivedMsgs, session.messages));

  const ledger = new Ledger();
  for (const op of ledgerOps as LedgerOp[]) ledger.apply(op);
  check("revive replays the ledger DAG to the merged trunk", eq(ledger.trunk, { owner: "ada", deadline: "monday" }) && !ledger.forked);

  // --- small: the bond is a fraction of the live op log --------------------
  const big: Session = {
    room: "lobby",
    created: 1700000000000,
    roster: ["ada", "claude", "bob"],
    messages: Array.from({ length: 400 }, (_v, i) => ({ author: ["ada", "claude", "bob"][i % 3], text: `message number ${i} in the thread` })),
    ledger: session.ledger,
  };
  const bond = encodeSave(big);
  const liveLog = JSON.stringify(framesFrom(big).ops); // the fat op frames (ids + after + author)
  check("a bond is well under half the live op log", bond.length * 2 < liveLog.length, `bond=${bond.length} live=${liveLog.length}`);

  // --- chunking: a large session splits, streams, and stays whole ----------
  const chunkLines: string[] = [];
  writeSave(big, (l) => chunkLines.push(l), { maxChunkBytes: 200 });
  check("a large session splits into many chunks", chunkLines.length - 1 > 1, `chunks=${chunkLines.length - 1}`);
  check("a chunked save round-trips", eq(decodeSave(chunkLines.join("\n")).messages, big.messages));

  const streamed: { author: string; text: string }[] = [];
  let streamedLedger = 0;
  streamFrames(chunkLines, {}, (f) => {
    if (f.ledgerOps) streamedLedger = f.ledgerOps.length;
    for (const op of f.ops ?? []) streamed.push({ author: op.author, text: op.value });
  });
  check("streamFrames rebuilds every message chunk-by-chunk", eq(streamed, big.messages) && streamedLedger === big.ledger.length);

  // --- integrity: a tampered chunk is caught -------------------------------
  const tampered = [...chunkLines];
  const c1 = JSON.parse(tampered[1]) as { body: string };
  c1.body = c1.body + "x"; // corrupt one chunk
  tampered[1] = JSON.stringify(c1);
  let integrityCaught = false;
  try {
    decodeSave(tampered.join("\n"));
  } catch {
    integrityCaught = true;
  }
  check("a tampered chunk fails the integrity check", integrityCaught);

  // --- sessionFromClient materializes from a client-shaped source ----------
  const src = {
    room: "lobby",
    participants: ["ada", "claude"],
    entries: (): Entry[] => [{ id: "x:1", author: "ada", value: "hi" }],
    ledgerOps: (): LedgerOp[] => [{ id: "x:2", type: "fork", branches: ["A", "B"] }],
  };
  const fromClient = sessionFromClient(src);
  check("sessionFromClient binds roster + messages + ledger (ids stripped)", eq(fromClient.roster, ["ada", "claude"]) && eq(fromClient.messages, [{ author: "ada", text: "hi" }]) && eq(fromClient.ledger, [{ type: "fork", branches: ["A", "B"] }]));

  // --- RoomStore: durable append/load --------------------------------------
  const mem = new MemoryRoomStore();
  mem.append("lobby", { t: "op", op: { id: "a:1", value: "e1:sealed" } });
  mem.append("lobby", { t: "ledger", op: { id: "a:2" } });
  check("MemoryRoomStore appends and loads in order", eq(mem.load("lobby").map((f) => f.t), ["op", "ledger"]));

  const dir = mkdtempSync(join(tmpdir(), "quorum-store-"));
  const fs1 = new FileRoomStore(dir);
  fs1.append("lobby", { t: "op", op: { id: "a:1", value: "e1:sealed-cipher" } });
  fs1.append("lobby", { t: "checkpoint", op: { id: "a:2", seat: "claude", handled: "a:1" } });
  const fs2 = new FileRoomStore(dir); // a fresh instance == a restart
  const loaded = fs2.load("lobby");
  check("FileRoomStore persists frames across restarts", loaded.length === 2 && (loaded[0].op as { value: string }).value === "e1:sealed-cipher");
  check("FileRoomStore keeps frames sealed at rest (stores them as-is)", (loaded[0].op as { value: string }).value.startsWith("e1:"));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main();
