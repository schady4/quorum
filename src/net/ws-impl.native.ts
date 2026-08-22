// The browser / React Native transport: a Socket backed by the platform's global
// WebSocket. No `ws` import, so it bundles cleanly for mobile and web. A bundler
// is redirected here from ws-impl.ts by the "react-native"/"browser" fields in
// package.json.
//
// The global WebSocket API differs from `ws`: event-listener registration, no
// terminate, and no way to send pings from JS (the platform auto-answers server
// pings). `canPing: false` tells RoomClient to skip its own silence-detection
// here; the relay's keepalive still reaps a dead mobile client.

import type { Socket } from "./socket.js";

// Minimal ambient shape so this compiles under a Node tsconfig (no DOM lib).
interface PlatformWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}
declare const WebSocket: { new (url: string): PlatformWebSocket };

export function makeSocket(url: string): Socket {
  const ws = new WebSocket(url);
  return {
    get readyState() {
      return ws.readyState;
    },
    canPing: false,
    send: (d) => ws.send(d),
    close: () => ws.close(),
    terminate: () => ws.close(),
    onOpen: (cb) => ws.addEventListener("open", () => cb()),
    onMessage: (cb) => ws.addEventListener("message", (ev) => cb(typeof ev.data === "string" ? ev.data : String(ev.data))),
    onClose: (cb) => ws.addEventListener("close", () => cb()),
    onError: (cb) => ws.addEventListener("error", () => cb(new Error("websocket error"))),
    onActivity: (cb) => ws.addEventListener("message", () => cb()),
    ping: () => {
      /* browser/RN can't send WS pings; server pings keep the link alive */
    },
  };
}
