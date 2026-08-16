// The chat backbone — a small, self-hostable relay. It broadcasts CRDT ops
// between the terminals in a room and keeps the room's op log so late joiners
// catch up. It is deliberately dumb: convergence is the CRDT math on each
// replica, not something the server computes. Run your own, or point at a
// shared one.

import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";
import { decode, encode, type CheckpointOp, type ServerMsg } from "../net/protocol.js";
import { authMatches } from "../net/crypto.js";

/** What the relay tracks per connected socket. */
interface Member {
  handle: string;
  /** The client's stable id, used to distinguish a reconnect from a collision. */
  clientId?: string;
}

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
  /** Connected sockets and who each is. */
  clients: Map<WebSocket, Member>;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

export interface RelayOptions {
  port: number;
  /** The join gate's auth token (derived from the room secret by the host — the
   *  relay never sees the secret itself). When set, a client must present the
   *  matching token in its hello or the join is refused. Omit for an open relay. */
  authToken?: string;
  /** Heartbeat interval (ms) for ping/pong liveness checks. A socket that misses
   *  a beat is terminated, so rosters stay accurate and handles free up promptly.
   *  Default 30s. */
  heartbeatMs?: number;
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

  const roster = (r: Room): string[] => [...r.clients.values()].map((m) => m.handle);

  // Liveness: a socket that fails to answer a ping between beats is presumed
  // dead and terminated. `alive` is flipped false when we ping and back to true
  // on the client's pong (the ws library auto-answers pings).
  const alive = new WeakMap<WebSocket, boolean>();
  const isDead = (ws: WebSocket): boolean => alive.get(ws) === false || ws.readyState !== ws.OPEN;

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: opts.port }, () => {
      const port = (wss.address() as AddressInfo).port;
      log(`quorum relay listening on ws://localhost:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const r of rooms.values()) for (const ws of r.clients.keys()) ws.terminate();
            wss.close(() => res());
          }),
      });
    });

    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          ws.terminate(); // missed the last beat — its close handler cleans up
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }, opts.heartbeatMs ?? 30_000);
    heartbeat.unref?.(); // never keep the process alive just for the heartbeat

    // A bind failure (e.g. port in use) must reject the promise, not hang the
    // awaiter forever. After `resolve` above has run, this reject is a no-op.
    wss.on("error", reject);

    wss.on("connection", (ws: WebSocket) => {
      let joined: Room | null = null;
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));

      ws.on("message", (data: Buffer) => {
        let msg;
        try {
          msg = decode(data.toString());
        } catch {
          return; // ignore malformed frames
        }

        if (msg.t === "hello") {
          if (!authMatches(opts.authToken, msg.auth)) {
            log(`✗ ${msg.handle} denied on ${msg.room} (bad room key)`);
            send(ws, { t: "denied", reason: "wrong or missing room key" });
            ws.close();
            return;
          }
          const r = room(msg.room);

          // Handle-uniqueness. If the handle is already held, decide by identity:
          // the same client reconnecting (or a dead/closing socket) reclaims it;
          // a different, still-live client is refused so two people can't share
          // a handle. Reconnects are always safe — same clientId never denies.
          for (const [sock, m] of r.clients) {
            if (sock === ws || m.handle !== msg.handle) continue;
            const sameClient = msg.clientId != null && m.clientId === msg.clientId;
            if (sameClient || isDead(sock)) {
              sock.terminate();
              r.clients.delete(sock);
            } else {
              log(`✗ ${msg.handle} denied on ${msg.room} (handle in use)`);
              send(ws, { t: "denied", reason: `handle "${msg.handle}" is already in use in this room` });
              ws.close();
              return;
            }
            break;
          }

          r.clients.set(ws, { handle: msg.handle, clientId: msg.clientId });
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
