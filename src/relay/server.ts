// The chat backbone — a small, self-hostable relay. It broadcasts CRDT ops
// between the terminals in a room and keeps the room's op log so late joiners
// catch up. It is deliberately dumb: convergence is the CRDT math on each
// replica, not something the server computes. Run your own, or point at a
// shared one.

import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";
import { decode, encode, type CheckpointOp, type ServerMsg } from "../net/protocol.js";

interface Room {
  /** Append-only chat-surface op log, deduped by op id. */
  ops: Op[];
  seen: Set<string>;
  /** Append-only ledger op log (fork/edit/merge), deduped by op id. */
  ledgerOps: LedgerOp[];
  ledgerSeen: Set<string>;
  /** Append-only seat-progress log, so a reconnecting seat resumes rather than
   *  re-answering. Deduped by op id. */
  checkpointOps: CheckpointOp[];
  checkpointSeen: Set<string>;
  /** Connected sockets and the handle each announced. */
  clients: Map<WebSocket, string>;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

export interface RelayOptions {
  port: number;
  /** Log connections/joins to stderr. Off in tests. */
  verbose?: boolean;
}

export function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const rooms = new Map<string, Room>();
  const log = (...a: unknown[]) => opts.verbose && console.error(...a);

  const room = (name: string): Room => {
    let r = rooms.get(name);
    if (!r) {
      r = { ops: [], seen: new Set(), ledgerOps: [], ledgerSeen: new Set(), checkpointOps: [], checkpointSeen: new Set(), clients: new Map() };
      rooms.set(name, r);
    }
    return r;
  };

  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(encode(msg));
  };

  const broadcast = (r: Room, msg: ServerMsg, except?: WebSocket) => {
    for (const ws of r.clients.keys()) if (ws !== except) send(ws, msg);
  };

  const roster = (r: Room): string[] => [...r.clients.values()];

  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: opts.port }, () => {
      const port = (wss.address() as AddressInfo).port;
      log(`quorum relay listening on ws://localhost:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const r of rooms.values()) for (const ws of r.clients.keys()) ws.terminate();
            wss.close(() => res());
          }),
      });
    });

    wss.on("connection", (ws: WebSocket) => {
      let joined: Room | null = null;

      ws.on("message", (data: Buffer) => {
        let msg;
        try {
          msg = decode(data.toString());
        } catch {
          return; // ignore malformed frames
        }

        if (msg.t === "hello") {
          const r = room(msg.room);
          r.clients.set(ws, msg.handle);
          joined = r;
          log(`+ ${msg.handle} joined ${msg.room} (${r.clients.size} here)`);
          send(ws, { t: "welcome", room: msg.room, participants: roster(r), ops: r.ops, ledgerOps: r.ledgerOps, checkpointOps: r.checkpointOps });
          broadcast(r, { t: "presence", participants: roster(r) });
          return;
        }

        if (msg.t === "op" && joined) {
          const { op } = msg;
          if (joined.seen.has(op.id)) return; // dedupe replayed ops
          joined.seen.add(op.id);
          joined.ops.push(op);
          broadcast(joined, { t: "op", op }, ws);
          return;
        }

        if (msg.t === "ledger" && joined) {
          const { op } = msg;
          if (joined.ledgerSeen.has(op.id)) return;
          joined.ledgerSeen.add(op.id);
          joined.ledgerOps.push(op);
          broadcast(joined, { t: "ledger", op }, ws);
          return;
        }

        if (msg.t === "checkpoint" && joined) {
          const { op } = msg;
          if (joined.checkpointSeen.has(op.id)) return;
          joined.checkpointSeen.add(op.id);
          joined.checkpointOps.push(op);
          broadcast(joined, { t: "checkpoint", op }, ws);
        }
      });

      ws.on("close", () => {
        if (!joined) return;
        joined.clients.delete(ws);
        broadcast(joined, { t: "presence", participants: roster(joined) });
      });
    });
  });
}
