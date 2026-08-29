// The `/quorum` command grammar — parsed, pure, and testable in isolation.
//
// Slack owns the `/` namespace: a raw `/fork A B` is intercepted by Slack as an
// unknown slash command and never reaches the channel. So the bridge registers
// exactly ONE slash command, `/quorum`, and namespaces every structured action
// beneath it (see docs/wiki/Slack-Bridge.md → "Command model"). This module
// turns the text that follows `/quorum` into a typed command; it performs no I/O
// and knows nothing about Slack or the room, so it can be unit-tested directly.
//
// Talking to an AI is NOT a command — `@claude summarize this` is ordinary
// channel text (an AI handle isn't a Slack member, so it stays literal) and is
// relayed as a normal message. Only the structured verbs live here.

/** A parsed `/quorum …` invocation. `refused`/`error` carry a user-facing note
 *  the bridge echoes back ephemerally (visible only to the caller). */
export type QuorumCommand =
  | { kind: "agent"; handle: string; provider?: string; model?: string }
  | { kind: "fork"; a: string; b: string }
  | { kind: "set"; branch: string; key: string; value: string }
  | { kind: "merge"; a: string; b: string }
  | { kind: "status" }
  | { kind: "help" }
  /** A command we recognize but decline on purpose — e.g. anything touching keys. */
  | { kind: "refused"; reason: string }
  /** Malformed input; `message` explains what was expected. */
  | { kind: "error"; message: string };

/** Split on whitespace, dropping empties. Slack collapses most runs already,
 *  but paste and mobile keyboards don't always. */
function tokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Pull `--flag value` pairs out of a token list, returning the bare positionals
 *  and a flag map. A flag with no following value maps to "" (treated as unset). */
function splitFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) flags[a.slice(2)] = args[++i] ?? "";
    else positionals.push(a);
  }
  return { positionals, flags };
}

const HELP =
  "`/quorum` commands:\n" +
  "• `/quorum agent <handle> [--provider <id>] [--model <id>]` — seat an AI in the room\n" +
  "• `/quorum fork <A> <B>` — branch the decision-state into two threads\n" +
  "• `/quorum set <branch> <key> <value>` — advance one branch\n" +
  "• `/quorum merge <A> <B>` — reconcile two branches\n" +
  "• `/quorum status` — who's live, branches, bridge state\n" +
  "\nTalking to an AI is just chat: type `@claude …` in the channel.\n" +
  "Keys never go through Slack — `/quorum key …` is refused by design.";

/** Parse the text that follows the `/quorum` slash command. `raw` is Slack's
 *  `command.text` (everything after `/quorum`); an empty string shows help. */
export function parseQuorumCommand(raw: string): QuorumCommand {
  const parts = tokens(raw ?? "");
  const verb = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1);

  if (!verb || verb === "help" || verb === "-h" || verb === "--help") return { kind: "help" };

  switch (verb) {
    case "key":
    case "keys":
      // The whole point: secrets never traverse Slack. Refuse loudly, never
      // silently, so nobody assumes it worked.
      return {
        kind: "refused",
        reason: "Keys never go through Slack. Room and provider keys stay on the bridge host — set them there with `quorum setup`.",
      };

    case "agent": {
      const { positionals, flags } = splitFlags(rest);
      const handle = positionals[0];
      if (!handle) return { kind: "error", message: "Usage: `/quorum agent <handle> [--provider <id>] [--model <id>]`" };
      return {
        kind: "agent",
        handle: handle.replace(/^@/, ""), // tolerate a leading @, store the bare handle
        ...(flags.provider ? { provider: flags.provider } : {}),
        ...(flags.model ? { model: flags.model } : {}),
      };
    }

    case "fork": {
      const [a, b] = rest;
      if (!a || !b) return { kind: "error", message: "Usage: `/quorum fork <A> <B>`" };
      return { kind: "fork", a, b };
    }

    case "merge": {
      const [a, b] = rest;
      if (!a || !b) return { kind: "error", message: "Usage: `/quorum merge <A> <B>`" };
      return { kind: "merge", a, b };
    }

    case "set": {
      const [branch, key, ...valueParts] = rest;
      const value = valueParts.join(" ");
      if (!branch || !key || !value) return { kind: "error", message: "Usage: `/quorum set <branch> <key> <value>`" };
      return { kind: "set", branch, key, value };
    }

    case "status":
      return { kind: "status" };

    default:
      return { kind: "error", message: `Unknown \`/quorum\` command: \`${verb}\`. Try \`/quorum help\`.` };
  }
}

export { HELP as QUORUM_HELP };
