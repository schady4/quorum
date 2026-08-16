// Integration proof of client-side keepalive: a client detects a relay that
// went silent WITHOUT closing the socket (sleep, NAT drop, crash) and starts
// reconnecting on its own — while a genuinely healthy relay is never falsely
// dropped. Offline; no model keys. Run with `npm run test:vanish`.
//
// The "vanished" relay is a raw TCP server that completes the WebSocket
// handshake (so the client's socket opens) and then ignores everything — no
// welcome, and crucially no pong to the client's pings. A real ws server would
// auto-answer pings and couldn't stand in for a dead peer.

import { createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
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

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A TCP server that upgrades a WebSocket then never speaks again. */
function silentRelay(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const socks = new Set<Socket>();
    const server = createServer((sock) => {
      socks.add(sock);
      sock.on("close", () => socks.delete(sock));
      sock.on("error", () => {});
      let buf = "";
      let upgraded = false;
      sock.on("data", (d) => {
        if (upgraded) return; // silent from here on — ignore every frame, incl. pings
        buf += d.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const m = buf.match(/sec-websocket-key:\s*(.+)\r\n/i);
        if (m) {
          const accept = createHash("sha1").update(m[1].trim() + WS_GUID).digest("base64");
          sock.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          upgraded = true;
        }
      });
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const s of socks) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

async function main(): Promise<void> {
  // --- A healthy relay is never falsely dropped by the heartbeat. ----------
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  const obs = new RoomClient(url, "lobby", "obs");
  obs.on("error", () => {});
  obs.connect();
  await nextOpen(obs);

  const healthy = new RoomClient(url, "lobby", "healthy");
  healthy.heartbeat.intervalMs = 60; // ping several times during the test
  let hOpens = 0;
  let hReconn = 0;
  healthy.on("open", () => hOpens++);
  healthy.on("reconnecting", () => hReconn++);
  healthy.on("error", () => {});
  healthy.connect();
  await nextOpen(healthy);

  await wait(400); // ~6 heartbeat beats against a live relay (which auto-pongs)
  healthy.send("still here");
  const delivered = await waitUntil(() => obs.entries().some((e: Entry) => e.author === "healthy" && e.value === "still here"));
  check("a live relay is not falsely dropped", hOpens === 1 && hReconn === 0 && delivered, `opens=${hOpens} reconnecting=${hReconn} delivered=${delivered}`);

  healthy.close();
  obs.close();
  await relay.close();

  // --- A silently vanished relay is detected and triggers a reconnect. -----
  const dead = await silentRelay();
  const deadUrl = `ws://localhost:${dead.port}`;

  const client = new RoomClient(deadUrl, "lobby", "ada");
  client.heartbeat.intervalMs = 60;
  client.reconnect.baseMs = 60;
  client.reconnect.maxMs = 200;
  let opens = 0;
  let reconnecting = 0;
  client.on("open", () => opens++);
  client.on("reconnecting", () => reconnecting++);
  client.on("error", () => {});
  client.connect();

  await nextOpen(client); // the socket opens (handshake completes)...
  check("socket opens against the silent relay", opens >= 1, `opens=${opens}`);

  // ...but with no pong for a whole interval, the client gives up and reconnects.
  const detected = await waitUntil(() => reconnecting >= 1, 2000);
  check("client detects the silent relay and reconnects", detected, `reconnecting=${reconnecting}`);

  client.close();
  await dead.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
