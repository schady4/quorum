// A room client. Connects to a relay, keeps a local CRDT replica of the room's
// message stream, and turns "send a message" into one CRDT op anchored at the
// current tail. Concurrent messages from different participants converge by the
// same causal-tree rule that orders characters — the chat stream is just an RGA
// whose elements are whole messages instead of single characters.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createSurface, type CrdtSurface, type Entry, type InsertOp } from "../core/crdt.js";
import { decode, encode } from "./protocol.js";

let _seq = 0;
/** A process-unique site id, so op ids never collide across clients. */
function newClientId(): string {
  return `${Date.now().toString(36)}-${(_seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface RoomClientEvents {
  update: (entries: Entry[]) => void;
  presence: (participants: string[]) => void;
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
}

export class RoomClient extends EventEmitter {
  readonly clientId = newClientId();
  private surface: CrdtSurface = createSurface();
  private counter = 0;
  private ws: WebSocket | null = null;
  participants: string[] = [];

  constructor(
    readonly url: string,
    readonly room: string,
    readonly handle: string,
  ) {
    super();
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(encode({ t: "hello", room: this.room, handle: this.handle }));
      this.emit("open");
    });

    ws.on("message", (data: Buffer) => {
      const msg = decode(data.toString());
      if (msg.t === "welcome") {
        for (const op of msg.ops) this.surface.apply(op);
        this.participants = msg.participants;
        this.emit("presence", this.participants);
        this.emit("update", this.surface.entries());
      } else if (msg.t === "op") {
        this.surface.apply(msg.op);
        this.emit("update", this.surface.entries());
      } else if (msg.t === "presence") {
        this.participants = msg.participants;
        this.emit("presence", this.participants);
      }
    });

    ws.on("close", () => this.emit("close"));
    ws.on("error", (err: Error) => this.emit("error", err));
  }

  /** Post a message: apply locally for instant echo, then broadcast the op. */
  send(text: string): void {
    const op: InsertOp = {
      type: "insert",
      id: `${this.clientId}:${++this.counter}`,
      after: this.surface.tail(),
      value: text,
      author: this.handle,
    };
    this.surface.apply(op);
    this.emit("update", this.surface.entries());
    this.ws?.send(encode({ t: "op", op }));
  }

  entries(): Entry[] {
    return this.surface.entries();
  }

  close(): void {
    this.ws?.close();
  }
}
