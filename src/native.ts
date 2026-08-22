// Quorum core SDK — the React Native / browser entry point. Same client and
// crypto as the main entry, but WITHOUT the modules that touch Node-only APIs
// (`fs`/`os` for on-disk saves, config, and the credential store; `zlib` for the
// .qdag codec; the AI-seat machinery that reads credentials). Those stay on the
// server/CLI. What's here is everything a mobile or web surface needs to join a
// room, converge, and read/write end-to-end-encrypted messages.
//
// Import this from a phone/web app: `import { RoomClient } from "@schady4/quorum/native"`.
// The transport and crypto resolve to their platform-native implementations
// automatically (see net/socket.ts and net/crypto.ts).

// --- The bus: join a room ----------------------------------------------------
export { RoomClient } from "./net/client.js";
export type { RoomClientEvents } from "./net/client.js";

// --- Auth + end-to-end encryption (one shared secret) ------------------------
export { roomCrypto, deriveAuthToken, authMatches, OPEN_ROOM } from "./net/crypto.js";
export type { RoomCrypto } from "./net/crypto.js";

// --- The wire protocol -------------------------------------------------------
export { encode, decode } from "./net/protocol.js";
export type {
  Hello,
  Welcome,
  OpFrame,
  LedgerFrame,
  CheckpointFrame,
  Denied,
  Presence,
  CheckpointOp,
  ClientMsg,
  ServerMsg,
} from "./net/protocol.js";

// --- Substrate: the converged surface + decision ledger ----------------------
export { createSurface, ROOT } from "./core/crdt.js";
export type { Entry, Op, InsertOp, OpId, CrdtSurface } from "./core/crdt.js";
export { threeWayMerge, contentHash } from "./core/dag.js";
export type { BeliefState, Conflict } from "./core/dag.js";
export { Ledger } from "./core/ledger.js";
export type { LedgerOp, HistoryEntry, MergePrep, MergeResolver } from "./core/ledger.js";

// --- Routing + providers (for reference / building requests) -----------------
export { route, dispatch, profileFor, scoreModel, classifyEffort } from "./router/index.js";
export type { RouteHint, RouteDecision } from "./router/index.js";
export { providers, getProvider } from "./providers/index.js";
export type {
  ProviderAdapter,
  CredentialSpec,
  ModelInfo,
  ChatMessage,
  GenerateRequest,
  GenerateResult,
} from "./providers/types.js";
