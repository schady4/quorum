// The Node transport: a Socket backed by the `ws` library. Loaded on the server
// and CLI. A React Native / browser bundle is redirected away from this file (to
// ws-impl.native.ts) so `ws` and its Node built-ins are never pulled in.

import { WebSocket } from "ws";
import type { Socket } from "./socket.js";

export function makeSocket(url: string): Socket {
  const ws = new WebSocket(url);
  return {
    get readyState() {
      return ws.readyState;
    },
    canPing: true,
    send: (d) => ws.send(d),
    close: () => ws.close(),
    terminate: () => ws.terminate(),
    onOpen: (cb) => {
      ws.on("open", cb);
    },
    onMessage: (cb) => {
      ws.on("message", (d: Buffer) => cb(d.toString()));
    },
    onClose: (cb) => {
      ws.on("close", () => cb());
    },
    onError: (cb) => {
      ws.on("error", (e: Error) => cb(e));
    },
    onActivity: (cb) => {
      ws.on("message", () => cb());
      ws.on("pong", () => cb());
      ws.on("ping", () => cb());
    },
    ping: () => {
      try {
        ws.ping();
      } catch {
        /* not open — the next heartbeat's readyState check handles it */
      }
    },
  };
}
