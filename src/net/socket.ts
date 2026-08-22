// Transport abstraction — the seam that lets RoomClient run anywhere. The Node
// CLI speaks WebSocket through the `ws` library (rich API: ping/pong, terminate);
// a browser or React Native app speaks through the platform's global WebSocket
// (event-listener API, no ping). RoomClient talks to this normalized `Socket`
// and never imports either directly, so the same client code runs on the server,
// the desktop, and the phone.
//
// Which implementation loads is chosen at bundle time: Node resolves ws-impl.ts
// (the `ws` version); a React Native / browser bundler is redirected to
// ws-impl.native.ts (the global-WebSocket version) by the "react-native" and
// "browser" fields in package.json — so `ws` and its Node built-ins never reach
// a mobile bundle.

/** WebSocket.OPEN is 1 in every implementation. */
export const OPEN = 1;

export interface Socket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  /** Force-drop the socket. Where the transport has no terminate (browser/RN),
   *  this is a plain close. */
  terminate(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
  /** Any inbound signal — a message, a pong, or a server ping — used for the
   *  client-side liveness check. */
  onActivity(cb: () => void): void;
  /** True only where the transport can send WS pings (Node `ws`). Browser/RN
   *  can't, so the client-side "is the relay silently gone?" heartbeat is
   *  skipped there (the relay's own keepalive still reaps dead clients). */
  readonly canPing: boolean;
  ping(): void;
}

export type SocketFactory = (url: string) => Socket;
