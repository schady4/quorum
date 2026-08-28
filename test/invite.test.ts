// Shareable invites: the join command is correct, the PRIVATE invite carries
// the key, and the PUBLIC/social invite NEVER leaks it. Run: npm run test:invite

import { joinCommand, privateInvite, socialInvite } from "../src/ui/invite.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const keyed = { room: "lobby", relay: "wss://abc123.ngrok.app", key: "hunter2" };
const open = { room: "lobby", relay: "ws://192.168.1.5:8787" };

test("join command includes room + relay + key", () => {
  const c = joinCommand(keyed);
  ok(c.includes("lobby") && c.includes("wss://abc123.ngrok.app") && c.includes("--key hunter2"), c);
  ok(c.startsWith("npx @schady4/quorum join"), c);
});

test("join command omits --key when there's no key", () => {
  ok(!joinCommand(open).includes("--key"), joinCommand(open));
});

test("join command has a bare-binary form (withNpx=false)", () => {
  ok(joinCommand(keyed, false).startsWith("quorum join lobby"), joinCommand(keyed, false));
});

test("PRIVATE invite carries the key", () => {
  ok(privateInvite(keyed).includes("--key hunter2"), "private invite should include the key");
});

test("PUBLIC invite NEVER leaks the key", () => {
  const s = socialInvite(keyed);
  ok(!s.includes("hunter2") && !s.includes("--key"), "social invite must not contain the key");
});

test("PUBLIC invite prompts to ask for the key privately when the room is keyed", () => {
  ok(/DM me for the room key/i.test(socialInvite(keyed)), "should tell people to DM for the key");
});

test("PUBLIC invite for an open room needs no key note", () => {
  ok(!/DM me for the room key/i.test(socialInvite(open)), "open room shouldn't mention a key");
});

test("both invites point at the repo", () => {
  ok(privateInvite(keyed).includes("github.com/schady4/quorum"), "private links repo");
  ok(socialInvite(keyed).includes("github.com/schady4/quorum"), "social links repo");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
