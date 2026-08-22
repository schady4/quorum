// The chat backbone — a small, self-hostable relay. It broadcasts CRDT ops
// between the terminals in a room and keeps the room's op log so late joiners
// catch up. It is deliberately dumb: convergence is the CRDT math on each
// replica, not something the server computes. Run your own, or point at a
// shared one.

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";
import { decode, encode, type CheckpointOp, type ServerMsg } from "../net/protocol.js";
import { authMatches } from "../net/crypto.js";
import { AUTH_HEADER } from "../net/blob.js";
import { expoPushSender, looksLikeExpoToken, type PushSender, type PushMessage } from "../net/push.js";
import type { RelayStore } from "./store.js";

/** What the relay tracks per connected socket. */
interface Member {
  handle: string;
  /** The client's stable id, used to distinguish a reconnect from a collision. */
  clientId?: string;
  /** Human or AI seat — so the roster can report who the humans are. */
  kind: "human" | "agent";
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
  /** The blob store: sealed (opaque) attachment bytes, keyed by content hash.
   *  The relay can't read them — same zero-knowledge property as the op log. */
  blobs: Map<string, Uint8Array>;
  /** Running total of stored blob bytes, so a room can be capped. */
  blobBytes: number;
  /** Device push tokens by handle, kept across disconnects so an offline member
   *  can be notified of new messages. Metadata only — never content. */
  pushTokens: Map<string, Set<string>>;
  /** Per-handle last-push time, to rate-limit notifications. */
  pushCooldown: Map<string, number>;
  /** Handles that muted this room — skipped by offline-notify. Kept across
   *  reconnects, so a mute holds even when the app is closed. */
  muted: Set<string>;
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
  /** Max bytes for a single blob attachment. Default 25 MB. */
  maxBlobBytes?: number;
  /** Max total blob bytes retained per room. Default 256 MB. */
  maxRoomBlobBytes?: number;
  /** Push notifications for disconnected members. On by default; set false to
   *  disable outbound push entirely. */
  push?: boolean;
  /** Override the push delivery (default posts to Expo). Injectable for tests or
   *  an alternate gateway. */
  sendPush?: PushSender;
  /** Endpoint for the default (Expo) push sender. */
  pushEndpoint?: string;
  /** Minimum ms between pushes to one handle in a room. Default 10s. */
  pushCooldownMs?: number;
  /** Durable storage. When set, op logs and blobs are persisted and reloaded on
   *  boot, so a room survives a relay restart even with no members online. */
  store?: RelayStore;
}

export function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const rooms = new Map<string, Room>();
  const log = (...a: unknown[]) => opts.verbose && console.error(...a);

  const room = (name: string): Room => {
    let r = rooms.get(name);
    if (!r) {
      r = { ops: [], seen: new Set(), ledgerOps: [], ledgerSeen: new Set(), checkpointOps: [], checkpointSeen: new Set(), clients: new Map(), blobs: new Map(), blobBytes: 0, pushTokens: new Map(), pushCooldown: new Map(), muted: new Set() };
      rooms.set(name, r);
    }
    return r;
  };
  const maxBlobBytes = opts.maxBlobBytes ?? 25 * 1024 * 1024;
  const maxRoomBlobBytes = opts.maxRoomBlobBytes ?? 256 * 1024 * 1024;
  const store = opts.store;

  /** Persist a room's per-member push/mute state (small; rewritten on change). */
  const persistMembers = (name: string, r: Room): void => {
    if (!store) return;
    const pushTokens: Record<string, string[]> = {};
    for (const [handle, set] of r.pushTokens) pushTokens[handle] = [...set];
    store.saveMembers(name, { pushTokens, muted: [...r.muted] });
  };

  // Reload persisted rooms so history — and offline members' push/mute state —
  // survives a restart even with nobody online.
  if (store) {
    for (const name of store.rooms()) {
      const r = room(name);
      const log = store.load(name);
      for (const op of log.ops) if (!r.seen.has(op.id)) { r.seen.add(op.id); r.ops.push(op); }
      for (const op of log.ledgerOps) if (!r.ledgerSeen.has(op.id)) { r.ledgerSeen.add(op.id); r.ledgerOps.push(op); }
      for (const op of log.checkpointOps) if (!r.checkpointSeen.has(op.id)) { r.checkpointSeen.add(op.id); r.checkpointOps.push(op); }
      const members = store.loadMembers(name);
      for (const [handle, tokens] of Object.entries(members.pushTokens)) r.pushTokens.set(handle, new Set(tokens));
      for (const handle of members.muted) r.muted.add(handle);
    }
  }

  // Push delivery for disconnected members. Content-free by construction — the
  // relay only knows who sent and which room, never what was said.
  const pushEnabled = opts.push !== false;
  const pushSender: PushSender = opts.sendPush ?? expoPushSender(opts.pushEndpoint);
  const pushCooldownMs = opts.pushCooldownMs ?? 10_000;

  const notifyOffline = (r: Room, roomName: string, authorHandle: string): void => {
    if (!pushEnabled || r.pushTokens.size === 0) return;
    const online = new Set([...r.clients.values()].map((m) => m.handle));
    const now = Date.now();
    const msgs: PushMessage[] = [];
    for (const [handle, tokens] of r.pushTokens) {
      if (handle === authorHandle || online.has(handle)) continue; // skip sender + connected
      if (r.muted.has(handle)) continue; // muted this room
      if (now - (r.pushCooldown.get(handle) ?? 0) < pushCooldownMs) continue; // rate-limit
      r.pushCooldown.set(handle, now);
      for (const to of tokens) {
        msgs.push({ to, title: roomName, body: `${authorHandle} sent a message`, data: { room: roomName }, sound: "default" });
      }
    }
    if (msgs.length) void pushSender(msgs);
  };

  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState === ws.OPEN) ws.send(encode(msg));
  };

  const broadcast = (r: Room, msg: ServerMsg, except?: WebSocket) => {
    for (const ws of r.clients.keys()) if (ws !== except) send(ws, msg);
  };

  const roster = (r: Room): string[] => [...r.clients.values()].map((m) => m.handle);
  const agentRoster = (r: Room): string[] => [...r.clients.values()].filter((m) => m.kind === "agent").map((m) => m.handle);

  // Liveness: a socket that fails to answer a ping between beats is presumed
  // dead and terminated. `alive` is flipped false when we ping and back to true
  // on the client's pong (the ws library auto-answers pings).
  const alive = new WeakMap<WebSocket, boolean>();
  const isDead = (ws: WebSocket): boolean => alive.get(ws) === false || ws.readyState !== ws.OPEN;

  // --- the blob store, served over HTTP on the same host/port ---------------
  // GET/PUT /blob/:room/:id. The relay stores only sealed (opaque) bytes keyed
  // by their content hash; it never decrypts them. Auth is the same room token
  // that gates the socket, presented in a header.
  const cors = (res: http.ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, PUT, OPTIONS");
    res.setHeader("access-control-allow-headers", `content-type, ${AUTH_HEADER}`);
  };
  const handleHttp = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    const path = (req.url ?? "").split("?")[0];

    // GET /rooms/summary?rooms=a,b,c — per-room op count + last activity (metadata
    // only). Auth-gated by the same room token as the socket.
    if (req.method === "GET" && path === "/rooms/summary") {
      if (!authMatches(opts.authToken, req.headers[AUTH_HEADER] as string | undefined)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const url = new URL(req.url ?? "", "http://localhost");
      const names = (url.searchParams.get("rooms") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const out: Record<string, { count: number; lastTs?: number; lastAuthor?: string }> = {};
      for (const name of names) {
        const r = rooms.get(name);
        if (!r) { out[name] = { count: 0 }; continue; }
        const last = r.ops[r.ops.length - 1];
        out[name] = {
          count: r.ops.length,
          lastTs: last && "ts" in last ? (last as { ts?: number }).ts : undefined,
          lastAuthor: last && "author" in last ? (last as { author?: string }).author : undefined,
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }

    const m = /^\/blob\/([^/]+)\/([^/]+)\/?$/.exec(path);
    if (!m) { res.writeHead(404).end(); return; }
    if (!authMatches(opts.authToken, req.headers[AUTH_HEADER] as string | undefined)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const roomName = decodeURIComponent(m[1]);
    const id = decodeURIComponent(m[2]);

    if (req.method === "GET") {
      let bytes = rooms.get(roomName)?.blobs.get(id);
      if (!bytes && store) {
        const loaded = store.loadBlob(roomName, id); // reload after a restart
        if (loaded) { bytes = loaded; room(roomName).blobs.set(id, loaded); }
      }
      if (!bytes) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) });
      res.end(Buffer.from(bytes));
      return;
    }

    if (req.method === "PUT") {
      const r = room(roomName);
      if (r.blobs.has(id)) { res.writeHead(200).end("ok"); return; } // idempotent
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on("data", (c: Buffer) => {
        if (aborted) return;
        size += c.length;
        if (size > maxBlobBytes || r.blobBytes + size > maxRoomBlobBytes) {
          aborted = true;
          res.writeHead(413).end("blob too large");
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        const bytes = new Uint8Array(Buffer.concat(chunks));
        r.blobs.set(id, bytes);
        r.blobBytes += bytes.byteLength;
        store?.saveBlob(roomName, id, bytes);
        log(`▣ blob ${id.slice(0, 8)}… stored on ${roomName} (${bytes.byteLength} B, ${r.blobs.size} total)`);
        res.writeHead(200).end("ok");
      });
      req.on("error", () => { if (!aborted) res.writeHead(400).end(); });
      return;
    }

    res.writeHead(405).end();
  };

  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(handleHttp);
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.on("error", reject);
    httpServer.listen(opts.port, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      log(`quorum relay listening on ws://localhost:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const r of rooms.values()) for (const ws of r.clients.keys()) ws.terminate();
            wss.close(() => httpServer.close(() => res()));
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
      let joinedName = "";
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

          r.clients.set(ws, { handle: msg.handle, clientId: msg.clientId, kind: msg.kind === "agent" ? "agent" : "human" });
          joined = r;
          joinedName = msg.room;
          log(`+ ${msg.handle} joined ${msg.room} (${r.clients.size} here)`);
          send(ws, { t: "welcome", room: msg.room, participants: roster(r), agents: agentRoster(r), ops: r.ops, ledgerOps: r.ledgerOps, checkpointOps: r.checkpointOps });
          broadcast(r, { t: "presence", participants: roster(r), agents: agentRoster(r) });
          return;
        }

        if (msg.t === "op" && joined) {
          const { op } = msg;
          if (joined.seen.has(op.id)) return; // dedupe replayed ops
          joined.seen.add(op.id);
          joined.ops.push(op);
          store?.appendOp(joinedName, op);
          broadcast(joined, { t: "op", op }, ws);
          // Notify any registered members who aren't connected right now.
          const sender = joined.clients.get(ws)?.handle ?? (op as { author?: string }).author ?? "someone";
          notifyOffline(joined, joinedName, sender);
          return;
        }

        if (msg.t === "ledger" && joined) {
          const { op } = msg;
          if (joined.ledgerSeen.has(op.id)) return;
          joined.ledgerSeen.add(op.id);
          joined.ledgerOps.push(op);
          store?.appendLedger(joinedName, op);
          broadcast(joined, { t: "ledger", op }, ws);
          return;
        }

        if (msg.t === "checkpoint" && joined) {
          const { op } = msg;
          if (joined.checkpointSeen.has(op.id)) return;
          joined.checkpointSeen.add(op.id);
          joined.checkpointOps.push(op);
          store?.appendCheckpoint(joinedName, op);
          broadcast(joined, { t: "checkpoint", op }, ws);
          return;
        }

        // Ephemeral signals (typing, read receipts): fan out to the others and
        // forget. Never stored, so they don't appear in a welcome or a save.
        if (msg.t === "signal" && joined) {
          broadcast(joined, { t: "signal", sig: msg.sig, from: msg.from, data: msg.data }, ws);
          return;
        }

        // Register a device push token for this member (kept across reconnects,
        // keyed by handle), so we can notify them while they're disconnected.
        if (msg.t === "register-push" && joined) {
          const member = joined.clients.get(ws);
          if (member && looksLikeExpoToken(msg.token)) {
            const set = joined.pushTokens.get(member.handle) ?? new Set<string>();
            set.add(msg.token);
            joined.pushTokens.set(member.handle, set);
            persistMembers(joinedName, joined);
            log(`⤵ push token registered for ${member.handle} on ${joinedName}`);
          }
          return;
        }

        // Mute / unmute this member's push for the room (held across reconnects).
        if (msg.t === "set-mute" && joined) {
          const member = joined.clients.get(ws);
          if (member) {
            if (msg.muted) joined.muted.add(member.handle);
            else joined.muted.delete(member.handle);
            persistMembers(joinedName, joined);
          }
        }
      });

      ws.on("close", () => {
        if (!joined) return;
        joined.clients.delete(ws);
        broadcast(joined, { t: "presence", participants: roster(joined), agents: agentRoster(joined) });
      });
    });
  });
}
