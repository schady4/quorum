# Build on the Bus (the SDK)

Under the terminal UI, Quorum's core is a **headless conversation bus** — a relay
plus an end-to-end-encrypted, provenance-carrying, converged log. It's the
package's library entry (no Ink/React pulled in), so a desktop or mobile surface,
a bridge into Slack / Discord / Twitch, or an external agent are all just **seats
on the same bus**:

```ts
import { startRelay, RoomClient, AgentSeat, createModelResponder } from "@schady4/quorum";

// host a room (or point a client at someone else's relay)
const relay = await startRelay({ port: 8787, authToken });

// join as a seat — the primitive every surface and bridge is built from
const room = new RoomClient("ws://localhost:8787", "lobby", "ada", roomKey);
room.on("update", (entries) => render(entries)); // your UI, or a bridge sink
room.connect();
room.send("hello from anywhere");

// seat an agent (any Responder — a model, or a bridge to an external agent)
new AgentSeat({
  relayUrl: "ws://localhost:8787",
  room: "lobby",
  handle: "claude",
  key: roomKey,
  respond: createModelResponder({ providerId: "anthropic" }),
}).start();
```

The wire contract is documented in
[PROTOCOL.md](https://github.com/schady4/quorum/blob/main/PROTOCOL.md): anything
that speaks it and holds the room key is a first-class participant,
indistinguishable on the bus from any other.

## On a phone or in the browser — `@schady4/quorum/native`

The default entry pulls in Node-only machinery (on-disk saves, the credential
store, the AI-seat runtime) that a **React Native or web** app can't bundle. For
those surfaces import the `/native` entry — the same `RoomClient`, room crypto,
and protocol, with everything that touches `node:fs`/`os`/`zlib` left on the
server:

```ts
import { RoomClient, roomCrypto } from "@schady4/quorum/native";
```

The transport and crypto resolve to pure-JS, platform-native implementations
automatically (Metro/web bundlers follow the package's `react-native`/`browser`
field maps), and their outputs match the Node build byte-for-byte — so a phone and
a laptop in the same room derive the same keys and decrypt each other. A guard
test walks this entry's import graph on every run and fails if a Node-only module
ever creeps back in.

> The mobile app ([quorum-app](https://github.com/schady4/quorum-app)) is built on
> this exact entry.

**Next:** [Providers](Providers) · [Saving & Reviving](Saving-and-Reviving)
