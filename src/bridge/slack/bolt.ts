// The real Slack wiring — the ONLY file that touches @slack/bolt, and it does so
// through a dynamic import so the dependency stays out of the core bundle (the
// RFC's "ship as a separate package" intent, honored in-tree: nothing else in
// Quorum imports Bolt, and the SDK's published surface never pulls it in).
//
// Everything with real logic lives in core.ts / commands.ts / cursors.ts and is
// unit-tested with fakes. This file just:
//   • builds a SlackGateway backed by chat.postMessage (stamping quorumOp into
//     message metadata for outbound idempotency),
//   • mints real RoomClient seats (one per Slack user — Model B identity),
//   • seats AIs on THIS host with THIS host's credentials (never a Slack key),
//   • routes the `/quorum` slash command and channel messages into the engine,
//   • and installs graceful SIGINT/SIGTERM shutdown.
//
// Socket Mode (no public URL) is used deliberately: it's the lowest-surface,
// self-hosted path from docs/wiki/Slack-Bridge.md → "Slack policy & compliance".

import { join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { RoomClient } from "../../net/client.js";
import { FileRoomStore } from "../../session/store.js";
import { spawnAgent } from "../../agent/spawn.js";
import { getProvider } from "../../providers/index.js";
import { loadCredentials, missingRequired } from "../../config/credentials.js";
import { SlackBridge, type SlackGateway, type RoomSeat } from "./core.js";
import { CursorStore } from "./cursors.js";

export interface BoltBridgeConfig {
  /** Slack Socket-Mode credentials. */
  botToken: string; // xoxb-…
  appToken: string; // xapp-… (Socket Mode)
  /** The single channel this bridge relays. */
  channelId: string;
  channelName?: string;
  /** The Quorum room binding (the room key lives HERE, never in Slack). */
  relayUrl: string;
  room: string;
  key?: string;
  /** Where cursors + the durable room log are kept. */
  stateDir?: string;
  /** Default provider/model for `/quorum agent` when the command omits them. */
  defaultProvider?: string;
  defaultModel?: string;
}

/** Build the whole config from the environment — the shape the CLI passes in. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BoltBridgeConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing ${k}. The Slack bridge needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL, and QUORUM_ROOM.`);
    return v;
  };
  return {
    botToken: need("SLACK_BOT_TOKEN"),
    appToken: need("SLACK_APP_TOKEN"),
    channelId: need("SLACK_CHANNEL"),
    channelName: env.SLACK_CHANNEL_NAME,
    relayUrl: env.QUORUM_RELAY ?? "ws://localhost:8787",
    room: need("QUORUM_ROOM"),
    key: env.QUORUM_KEY,
    stateDir: env.QUORUM_BRIDGE_STATE,
    defaultProvider: env.QUORUM_AGENT_PROVIDER ?? "anthropic",
    defaultModel: env.QUORUM_AGENT_MODEL,
  };
}

interface BoltHandle {
  stop(): Promise<void>;
}

/** Start the bridge against a live Slack workspace. Resolves once Socket Mode is
 *  connected; call `stop()` (or send SIGINT/SIGTERM) to shut down gracefully. */
export async function runSlackBridge(config: BoltBridgeConfig): Promise<BoltHandle> {
  // Optional peer dependency, resolved only when the bridge actually runs. Kept
  // as a dynamic import + ts-ignore so neither `tsc` nor the core bundle require
  // @slack/bolt to be installed.
  let Bolt: any;
  try {
    // @ts-ignore optional dependency — install with `npm i @slack/bolt` to run the bridge
    Bolt = await import("@slack/bolt");
  } catch {
    throw new Error("@slack/bolt is not installed. Run `npm i @slack/bolt` on the bridge host to use `quorum bridge slack`.");
  }

  const app = new Bolt.App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: Bolt.LogLevel?.WARN,
  });
  const web = app.client;

  const stateDir = config.stateDir ?? pathJoin(homedir(), ".quorum", "bridge", slug(`${config.room}-${config.channelId}`));
  const cursors = new CursorStore(pathJoin(stateDir, "cursors.json"));
  // One shared durable room log — every seat reseeds the relay from it, so the
  // Quorum side self-heals after a relay restart (the "no data loss" guarantee).
  const store = new FileRoomStore(pathJoin(stateDir, "room"));

  const gateway: SlackGateway = {
    async post({ text, username, quorumOp }): Promise<string> {
      const res = await web.chat.postMessage({
        channel: config.channelId,
        text,
        ...(username ? { username } : {}),
        ...(quorumOp
          ? { metadata: { event_type: "quorum_relay", event_payload: { quorumOp } } }
          : {}),
      });
      return String(res.ts ?? "");
    },
  };

  const makeSeat = (handle: string, kind: "human" | "agent"): RoomSeat => {
    const seat = new RoomClient(config.relayUrl, config.room, handle, config.key, kind);
    seat.store = store;
    return seat as unknown as RoomSeat;
  };

  const seatAgent = async (spec: { handle: string; provider?: string; model?: string }): Promise<() => void> => {
    const providerId = spec.provider ?? config.defaultProvider ?? "anthropic";
    const provider = getProvider(providerId);
    if (!provider) throw new Error(`unknown provider "${providerId}"`);
    const missing = missingRequired(provider, loadCredentials(provider));
    if (missing.length) throw new Error(`${providerId} is missing ${missing.join(", ")} on the bridge host — run \`quorum setup\``);
    const seat = spawnAgent({
      relayUrl: config.relayUrl,
      room: config.room,
      handle: spec.handle,
      key: config.key,
      providerId,
      model: spec.model ?? config.defaultModel,
    });
    return () => seat.close();
  };

  const bridge = new SlackBridge({
    gateway,
    cursors,
    makeSeat,
    seatAgent,
    room: config.room,
    channel: config.channelName ?? config.channelId,
    log: (line) => console.error(`[bridge] ${line}`),
  });

  // Channel chat → the room. Ignore the bridge's own posts (bot messages) and
  // anything outside the bridged channel; resolve the author's display name so
  // Model B maps a stable handle.
  app.message(async ({ message }: any) => {
    if (message.channel !== config.channelId) return;
    if (message.subtype || message.bot_id) return; // edits/joins/bot echoes — v1 relays plain user text only
    const userName = await displayName(web, message.user);
    bridge.onSlackMessage({
      userId: message.user,
      userName,
      text: await resolveMentions(web, String(message.text ?? "")),
      ts: message.ts,
    });
  });

  // The single registered slash command — everything structured lives under it,
  // so it can never collide with Slack's `/` built-ins or another app's command.
  app.command("/quorum", async ({ command, ack, respond }: any) => {
    await ack();
    await bridge.onSlackCommand(
      { userId: command.user_id, text: command.text ?? "" },
      async ({ text, inChannel }) => {
        await respond({ text, response_type: inChannel ? "in_channel" : "ephemeral" });
      },
    );
  });

  await app.start();
  bridge.start();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await bridge.shutdown();
    try {
      await app.stop();
    } catch {
      /* ignore */
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void stop().then(() => process.exit(0));
    });
  }
  return { stop };
}

/** Resolve a Slack user id to a display name (cached per process). */
const nameCache = new Map<string, string>();
async function displayName(web: any, userId: string): Promise<string> {
  if (!userId) return "someone";
  const hit = nameCache.get(userId);
  if (hit) return hit;
  try {
    const res = await web.users.info({ user: userId });
    const p = res.user?.profile ?? {};
    const name = p.display_name || p.real_name || res.user?.name || userId;
    nameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/** Rewrite Slack's `<@U…>` mention encoding into `@name` so the room (and AIs)
 *  see readable handles instead of opaque ids. */
async function resolveMentions(web: any, text: string): Promise<string> {
  const ids = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
  let out = text;
  for (const id of ids) {
    const name = await displayName(web, id);
    out = out.replaceAll(`<@${id}>`, `@${name}`);
  }
  return out;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "room";
}
