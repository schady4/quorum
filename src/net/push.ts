// The push sender — how a relay notifies a disconnected member that a room has
// activity. Deliberately content-free: the relay is zero-knowledge, so a push
// carries only metadata it already sees (who sent, which room), never the
// message text (which it can't read).
//
// The default sender posts to Expo's push service; it's injectable so a relay
// can point at a different gateway, and so tests can observe payloads without
// hitting the network.

export interface PushMessage {
  /** Recipient device token (Expo push token). */
  to: string;
  title: string;
  body: string;
  /** Deep-link payload — e.g. { room } so the app can open the right room. */
  data?: Record<string, unknown>;
  sound?: "default" | null;
}

/** Delivers a batch of push messages. */
export type PushSender = (messages: PushMessage[]) => Promise<void>;

export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** A sender that posts to Expo's push API (or a compatible endpoint). Batches in
 *  groups of 100 per Expo's guidance. Failures are swallowed per-batch — a push
 *  that doesn't land must never break message delivery. */
export function expoPushSender(endpoint: string = EXPO_PUSH_ENDPOINT): PushSender {
  return async (messages: PushMessage[]): Promise<void> => {
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100).map((m) => ({ sound: "default" as const, ...m }));
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(batch),
        });
      } catch {
        /* best-effort: never let a push failure disrupt the relay */
      }
    }
  };
}

/** Expo push tokens look like `ExponentPushToken[…]` or `ExpoPushToken[…]`. A
 *  light sanity check so obviously-bad tokens aren't stored. */
export function looksLikeExpoToken(token: unknown): token is string {
  return typeof token === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(token);
}
