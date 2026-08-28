// Shareable room invites — the terminal's viral loop. Pure text builders so
// they're unit-testable and reusable by the CLI's `invite` command and `host`.
//
// SECURITY: a room key is the shared secret that both gates joins AND decrypts
// the traffic. So the PRIVATE invite (DM / email) carries the key, but the
// PUBLIC / social post NEVER does — putting a room key in a tweet would let
// anyone read the end-to-end-encrypted room. `socialInvite` drops the key by
// construction and tells people to ask for it privately.

const PKG = "@schady4/quorum";
const REPO = "https://github.com/schady4/quorum";

export interface InviteInput {
  room: string;
  relay: string;
  key?: string;
}

/** The one-line join command. `npx` form by default so a newcomer needs no install. */
export function joinCommand({ room, relay, key }: InviteInput, withNpx = true): string {
  const bin = withNpx ? `npx ${PKG} join` : "quorum join";
  return `${bin} ${room} --relay ${relay}${key ? ` --key ${key}` : ""}`;
}

/** A friendly, multi-line invite for a PRIVATE channel (DM, email) — includes the key. */
export function privateInvite(i: InviteInput): string {
  return [
    `You're invited to a Quorum room — multiplayer AI chat in your terminal.`,
    `Humans and AI models (Claude, GPT, Llama…) share one live, end-to-end-`,
    `encrypted session. Join in one line:`,
    ``,
    `  ${joinCommand(i)}`,
    ``,
    `New here?  npm i -g ${PKG}   ·   ${REPO}`,
  ].join("\n");
}

/** A short PUBLIC post (Twitter/X, Mastodon). NEVER includes the room key. */
export function socialInvite(i: InviteInput): string {
  const encrypted = !!i.key;
  const cmd = joinCommand({ ...i, key: undefined }); // key omitted on purpose
  const lines = [
    `Running a Quorum room — multiplayer AI chat right in the terminal 🤖💬`,
    `Claude + GPT + friends in one live${encrypted ? ", end-to-end-encrypted" : ""} session.`,
    ``,
    `Join: ${cmd}`,
  ];
  if (encrypted) lines.push(`(DM me for the room key 🔑)`);
  lines.push(`↳ ${REPO}`);
  return lines.join("\n");
}
