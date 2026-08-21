// Quorum core SDK — the headless conversation bus, without the CLI or the
// terminal UI. This is the public contract every edge builds on: a desktop or
// mobile surface, a bridge into Slack/Discord/Twitch, or an external agent are
// all just consumers of what's exported here. Nothing in this module pulls in
// Ink/React or the CLI, so it's safe to depend on from any host.
//
// The shape of the bus:
//   - startRelay(...)  host the room server (the transport).
//   - RoomClient       join a room as a SEAT — the primitive every human
//                      surface and every bridge is built from.
//   - AgentSeat / spawnAgent / createModelResponder
//                      build an AI participant (or bridge an external agent in).
//   - roomCrypto / deriveAuthToken
//                      the one shared secret -> relay auth token + E2E key.
//
// A "seat" is anything that speaks the protocol and holds the room key. That is
// the whole basis for a universal pipeline: one converged, provenance-carrying,
// end-to-end-encrypted log, many faces.
//
// NOTE: this SDK targets Node hosts (it uses `ws` for the socket). A browser
// surface needs the same client over the platform's native WebSocket — a thin
// transport swap planned for the web/desktop/mobile phase.

// --- The bus: host a relay, join a room --------------------------------------
export { startRelay } from "./relay/server.js";
export type { RelayHandle, RelayOptions } from "./relay/server.js";
export { RoomClient } from "./net/client.js";
export type { RoomClientEvents } from "./net/client.js";

// --- Auth + end-to-end encryption (one shared secret) ------------------------
export { roomCrypto, deriveAuthToken, authMatches, OPEN_ROOM } from "./net/crypto.js";
export type { RoomCrypto } from "./net/crypto.js";

// --- The wire protocol (the stable public contract; see PROTOCOL.md) ---------
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

// --- Seats: build an AI participant or bridge an external agent in ------------
export { AgentSeat, mentionTrigger, parseDelegate } from "./agent/seat.js";
export type { AgentSeatOptions, TriggerPolicy, DelegateSpec } from "./agent/seat.js";
export { createModelResponder, createDelegateResponder, extractAssignment } from "./agent/responder.js";
export type { Responder, ResponderOptions, DelegateResponderOptions } from "./agent/responder.js";
export { spawnAgent } from "./agent/spawn.js";
export type { SpawnConfig } from "./agent/spawn.js";
export { createMergeResolver } from "./agent/merge.js";
export type { MergeResolverOptions } from "./agent/merge.js";

// --- Routing: pick a model by intent + effort --------------------------------
export { route, dispatch, profileFor, scoreModel, classifyEffort } from "./router/index.js";
export type { RouteHint, RouteDecision } from "./router/index.js";

// --- Providers: the model-adapter extensibility surface ----------------------
export { providers, getProvider } from "./providers/index.js";
export type {
  ProviderAdapter,
  CredentialSpec,
  ModelInfo,
  ChatMessage,
  GenerateRequest,
  GenerateResult,
} from "./providers/types.js";

// --- Credentials: resolve provider keys from env + local store ---------------
export { loadCredentials, missingRequired } from "./config/credentials.js";
