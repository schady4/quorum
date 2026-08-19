// The terminal chat window — the "friends window". Renders the converged
// message stream, the participant roster, the DAG decision-ledger (trunk +
// branches + recent history), and a submit line. Humans and AI participants
// appear the same way; a seat is a seat.
//
// The input line doubles as a command line: lines starting with "/" drive the
// ledger (fork / set / merge) and AI seats (agent / key) — everything else is
// a chat message. The view is a pure function of the RoomClient's converged
// CRDT + ledger state.
//
// `/agent` and `/key` exist so seating your own AI never requires a second
// terminal: without them, a room creator who wants their own model has to
// leave the chat, open another shell, and run `quorum agent` there — a drop-off
// right at the moment they're most engaged. Both commands stay local (never
// broadcast to the room, same as /fork /set /merge) and write through the same
// credential store `quorum setup` uses, so either path stays in sync.

import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import type { Entry } from "../core/crdt.js";
import type { Ledger, MergeResolver } from "../core/ledger.js";
import { RoomClient } from "../net/client.js";
import { type Line, EMPTY, fromValue, insert, backspace, del, left, right, home, end, pushHistory, historyValue } from "./lineedit.js";
import { windowFor, clampOffset } from "./viewport.js";
import { hueIndex, INK_HANDLE_PALETTE } from "../ui/style.js";
import { spawnAgent } from "../agent/spawn.js";
import type { AgentSeat } from "../agent/seat.js";
import { providers, getProvider } from "../providers/index.js";
import { loadCredentials, missingRequired, testProvider } from "../config/credentials.js";
import { loadStore, saveStore } from "../config/store.js";

function colorFor(author: string): (typeof INK_HANDLE_PALETTE)[number] {
  return INK_HANDLE_PALETTE[hueIndex(author, INK_HANDLE_PALETTE.length)];
}

/** A denied join is always one of two things — a stale/missing room key, or a
 *  handle collision — and each has one concrete fix. Turn the relay's bare
 *  reason string into that fix instead of leaving someone to guess whether the
 *  problem is their key, their handle, or the relay address. */
export function deniedHelp(reason: string, relayUrl: string): string {
  if (reason.includes("already in use")) {
    return `join denied — ${reason}. Pick a different --as handle (someone already holds this one — maybe you, in another window).`;
  }
  return (
    `join denied — ${reason}. Ask whoever ran \`quorum host\` for their invite line ` +
    `(it looks like: quorum join <room> --relay ${relayUrl} --key <key>), or if that's ` +
    `you, check that terminal for the key it printed.`
  );
}

/** Display-only masking for `/key <provider> <secret>` while it's being typed
 *  — the underlying Line keeps the real value (needed to submit it correctly),
 *  only the on-screen render swaps the secret portion for bullets. */
export function maskForDisplay(value: string): string {
  const m = /^(\/key\s+\S+\s+)([\s\S]*)$/.exec(value);
  return m ? m[1] + "•".repeat(m[2].length) : value;
}

function kv(state: Record<string, string>): string {
  const keys = Object.keys(state);
  return keys.length ? keys.map((k) => `${k}=${state[k]}`).join("  ") : "(empty)";
}

/** Rendered height (in rows) of the ledger panel, so the message viewport can
 *  size itself to whatever is left. Mirrors LedgerView's layout. */
function ledgerHeight(l: Ledger): number {
  let h = 2 + 2; // round border + trunk label + trunk kv
  if (l.forked) h += l.branchNames().length;
  const hist = Math.min(3, l.history.length);
  if (hist > 0) h += 1 + hist; // marginTop + up to three history lines
  return h;
}

function LedgerView({ ledger }: { ledger: Ledger }) {
  const history = ledger.history.slice(-3);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="blueBright">trunk</Text>
      <Text color="gray">  {kv(ledger.trunk)}</Text>
      {ledger.forked &&
        ledger.branchNames().map((name) => (
          <Text key={name}>
            <Text color={colorFor(name)}>  ⑂ {name} </Text>
            <Text color="gray">{kv(ledger.branches.get(name) ?? {})}</Text>
          </Text>
        ))}
      {history.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {history.map((h, i) => (
            <Text key={i} color="gray">
              {h.kind === "merge" ? "⑃" : h.kind === "fork" ? "⑂" : "○"} {h.summary} <Text color="gray">{h.hash}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function App({ client, resolver }: { client: RoomClient; resolver?: MergeResolver }) {
  const app = useApp();
  const [entries, setEntries] = useState<Entry[]>(client.entries());
  const [participants, setParticipants] = useState<string[]>(client.participants);
  const [, forceLedger] = useState(0);
  const [line, setLine] = useState<Line>(EMPTY);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<"connecting" | "online" | "reconnecting" | "denied">("connecting");
  // A separate, dedicated line for "is this even set up right?" — kept apart
  // from `notice` so a stuck connection's hint can't be clobbered by (or
  // clobber) command feedback, and vice versa.
  const [connHint, setConnHint] = useState("");

  // ↑/↓ command history, with the live draft stashed while recalling.
  const [history, setHistory] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState(0);
  const draftStash = useRef("");

  // AI seats spawned in-process via /agent — closed alongside our own
  // connection on quit, and tracked here (not the room roster) purely to
  // animate a "thinking…" indicator while one is generating a reply.
  const spawnedSeats = useRef<AgentSeat[]>([]);
  const [thinking, setThinking] = useState<Set<string>>(new Set());
  const [spinTick, setSpinTick] = useState(0);
  useEffect(() => {
    if (thinking.size === 0) return;
    const t = setInterval(() => setSpinTick((n) => n + 1), 90);
    return () => clearInterval(t);
  }, [thinking.size]);
  const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  // Message viewport: terminal rows, and how far scrolled up from the newest.
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [offset, setOffset] = useState(0);
  const viewportRef = useRef(1);
  const prevLen = useRef(entries.length);

  useEffect(() => {
    const onUpdate = (e: Entry[]) => setEntries([...e]);
    const onPresence = (p: string[]) => setParticipants([...p]);
    const onLedger = () => forceLedger((n) => n + 1);
    const onOpen = () => {
      setStatus("online");
      setConnHint(""); // whatever was wrong (if anything) no longer is
    };
    const onReconnecting = (info: { attempt: number; delayMs: number }) => {
      setStatus("reconnecting");
      // One failed attempt is a normal blip (relay restart, laptop woke up) —
      // stay quiet. A run of them, still on the very first connection, is the
      // "I don't think this is set up right" case: nothing is listening at
      // this address, or it's the wrong one entirely.
      if (info.attempt >= 3) {
        setConnHint(`still can't reach ${client.url} after ${info.attempt} tries — is \`quorum host\` running there? check --relay if this address looks wrong.`);
      }
    };
    const onDenied = (reason: string) => {
      setStatus("denied");
      setConnHint("");
      setNotice(deniedHelp(reason, client.url));
    };
    client.on("update", onUpdate);
    client.on("presence", onPresence);
    client.on("ledger", onLedger);
    client.on("open", onOpen);
    client.on("reconnecting", onReconnecting);
    client.on("denied", onDenied);
    return () => {
      client.off("update", onUpdate);
      client.off("presence", onPresence);
      client.off("ledger", onLedger);
      client.off("open", onOpen);
      client.off("reconnecting", onReconnecting);
      client.off("denied", onDenied);
    };
  }, [client]);

  // Track the terminal size so the viewport reflows on resize.
  useEffect(() => {
    const onResize = () => setRows(stdout.rows || 24);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // Auto-scroll: pinned to the newest when at the bottom; hold position (shift
  // by the number of new messages) when the reader has scrolled up.
  useEffect(() => {
    const delta = entries.length - prevLen.current;
    prevLen.current = entries.length;
    if (delta > 0) setOffset((o) => (o > 0 ? clampOffset(entries.length, viewportRef.current, o + delta) : 0));
  }, [entries.length]);

  function runCommand(line: string): void {
    const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
    try {
      if (cmd === "fork") {
        client.fork(args.length ? args : ["A", "B"]);
        setNotice(`forked → ${(args.length ? args : ["A", "B"]).join(", ")}`);
      } else if (cmd === "set") {
        const [branch, key, ...rest] = args;
        if (!branch || !key || !rest.length) setNotice("usage: /set <branch> <key> <value>");
        else {
          client.setDecision(branch, key, rest.join(" "));
          setNotice(`${branch}: ${key} = ${rest.join(" ")}`);
        }
      } else if (cmd === "merge") {
        const [a, b] = args;
        if (!a || !b) setNotice("usage: /merge <branchA> <branchB>");
        else {
          setNotice(`merging ${a} + ${b}…`);
          client
            .merge(a, b, resolver)
            .then((r) =>
              setNotice(
                r.conflicts === 0
                  ? `merged ${a}+${b} mechanically · 0 inference`
                  : r.arbitrated
                    ? `merged ${a}+${b} · ${r.conflicts} collision(s) · 1 AI call`
                    : `merged ${a}+${b} · ${r.conflicts} unresolved (no arbiter — pass --provider)`,
              ),
            )
            .catch((e) => setNotice(e instanceof Error ? e.message : String(e)));
        }
      } else if (cmd === "agent") {
        const [handle, ...flagArgs] = args;
        if (!handle) {
          setNotice("usage: /agent <handle> [--provider <id>] [--model <id>]  ·  providers: " + providers.map((p) => p.id).join(", "));
        } else {
          const flags: Record<string, string> = {};
          for (let i = 0; i < flagArgs.length; i++) if (flagArgs[i].startsWith("--")) flags[flagArgs[i].slice(2)] = flagArgs[++i] ?? "";
          const providerId = flags.provider ?? "anthropic";
          const model = flags.model;
          const provider = getProvider(providerId);
          if (!provider) {
            setNotice(`unknown provider "${providerId}" — providers: ${providers.map((p) => p.id).join(", ")}`);
          } else {
            const creds = loadCredentials(provider);
            const missing = missingRequired(provider, creds);
            if (missing.length) {
              setNotice(`${provider.id} needs ${missing.join(", ")} — set it with /key ${provider.id} <value>, then /agent again`);
            } else {
              setNotice(`checking ${provider.label} credentials…`);
              testProvider(provider, creds).then((check) => {
                if (!check.ok) {
                  setNotice(`✗ ${provider.label}: ${check.message} — fix with /key ${provider.id} <value>`);
                  return;
                }
                const seat = spawnAgent({
                  relayUrl: client.url,
                  room: client.room,
                  handle,
                  key: client.key,
                  providerId,
                  model,
                  onThinking: (h) => setThinking((s) => new Set(s).add(h)),
                  onReply: (h) =>
                    setThinking((s) => {
                      if (!s.has(h)) return s;
                      const next = new Set(s);
                      next.delete(h);
                      return next;
                    }),
                  onError: (h, e) => {
                    setThinking((s) => {
                      if (!s.has(h)) return s;
                      const next = new Set(s);
                      next.delete(h);
                      return next;
                    });
                    setNotice(`[${h}] ${e.message}`);
                  },
                });
                spawnedSeats.current.push(seat);
                setNotice(`✓ ${handle} joined via ${providerId}${model ? "/" + model : ""} — mention @${handle} to talk to it`);
              });
            }
          }
        }
      } else if (cmd === "key") {
        const [providerId, ...rest] = args;
        const provider = providerId ? getProvider(providerId) : undefined;
        if (!provider) {
          setNotice(`usage: /key <provider> <value>  ·  providers: ${providers.map((p) => p.id).join(", ")}`);
        } else {
          const named = provider.credentials.find((c) => c.key === rest[0]);
          const credKey = named?.key ?? provider.credentials.find((c) => c.required && c.secret)?.key ?? provider.credentials.find((c) => c.required)?.key;
          const value = (named ? rest.slice(1) : rest).join(" ");
          if (!credKey) {
            setNotice(`${provider.id} has no configurable credential`);
          } else if (!value) {
            setNotice(`usage: /key ${provider.id} <value>`);
          } else {
            const store = loadStore();
            store[credKey] = value;
            saveStore(store);
            setNotice(`saved ${credKey} for ${provider.label} — try /agent <handle> --provider ${provider.id}`);
          }
        }
      } else if (cmd === "help") {
        setNotice(
          "/fork [names] · /set <branch> <key> <value> · /merge <a> <b> · /agent <handle> [--provider <id>] [--model <id>] · /key <provider> <value>",
        );
      } else {
        setNotice(`unknown command: /${cmd}`);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // Size the message viewport to whatever rows are left after the fixed chrome
  // (header 3 · conn hint 1 · ledger · scroll hint 1 · message padding 2 ·
  // notice 1 · input 3 · footer 1), then take the visible slice.
  const viewportRows = Math.max(3, rows - (12 + ledgerHeight(client.ledger)));
  viewportRef.current = viewportRows;
  const win = windowFor(entries.length, viewportRows, offset);
  const visible = entries.slice(win.start, win.end);

  useInput((input, key) => {
    // A denied join is terminal — client.ts never retries it, so nothing typed
    // from here on can ever reach anyone. RoomClient.send() still applies an
    // optimistic local echo even when the socket isn't live (that's what makes
    // reconnect-and-catch-up work), which on a *denied* room instead produces a
    // phantom message that looks sent but never left the machine. Refuse all
    // input but quit once denied, rather than let that illusion happen.
    if (status === "denied") {
      if (key.escape) {
        client.close();
        app.exit();
      }
      return;
    }

    // Scroll the message history.
    if (key.pageUp) return setOffset((o) => clampOffset(entries.length, viewportRows, o + Math.max(1, viewportRows - 1)));
    if (key.pageDown) return setOffset((o) => clampOffset(entries.length, viewportRows, o - Math.max(1, viewportRows - 1)));

    if (key.return) {
      const text = line.value.trim();
      if (text) {
        const willAdd = history[history.length - 1] !== text;
        if (text.startsWith("/")) runCommand(text);
        else client.send(text);
        setHistory((h) => pushHistory(h, text));
        setHistIndex(history.length + (willAdd ? 1 : 0));
      }
      setLine(EMPTY);
      setOffset(0); // sending jumps back to the newest
      draftStash.current = "";
      return;
    }
    if (key.escape) {
      for (const seat of spawnedSeats.current) seat.close();
      client.close();
      app.exit();
      return;
    }

    // ↑/↓ recall previous inputs; the in-progress draft is stashed and restored.
    if (key.upArrow) {
      if (history.length === 0) return;
      if (histIndex >= history.length) draftStash.current = line.value;
      const idx = Math.max(0, histIndex - 1);
      setHistIndex(idx);
      setLine(fromValue(historyValue(history, idx, draftStash.current)));
      return;
    }
    if (key.downArrow) {
      if (histIndex >= history.length) return;
      const idx = histIndex + 1;
      setHistIndex(idx);
      setLine(fromValue(historyValue(history, idx, draftStash.current)));
      return;
    }

    // Cursor movement and editing.
    if (key.leftArrow) return setLine(left);
    if (key.rightArrow) return setLine(right);
    if (key.backspace) return setLine(backspace);
    if (key.delete) return setLine(del);
    if (key.ctrl && input === "a") return setLine(home);
    if (key.ctrl && input === "e") return setLine(end);
    if (input && !key.ctrl && !key.meta) return setLine((l) => insert(l, input));
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="blueBright">◇ quorum · #{client.room}</Text>
        <Text>
          <Text color={status === "online" ? "green" : status === "denied" ? "red" : status === "reconnecting" ? "yellow" : "gray"}>
            {status === "online" ? "●" : "○"}{" "}
          </Text>
          <Text color="gray">
            {status === "denied" ? (
              "denied"
            ) : status === "reconnecting" ? (
              "reconnecting…"
            ) : status === "connecting" ? (
              "connecting…"
            ) : participants.length ? (
              participants.map((p, i) => (
                <Text key={p}>
                  {i > 0 && ", "}
                  {p}
                  {thinking.has(p) && <Text color="blueBright"> {SPIN_FRAMES[spinTick % SPIN_FRAMES.length]}</Text>}
                </Text>
              ))
            ) : (
              "…"
            )}
          </Text>
        </Text>
      </Box>

      {/* one fixed line so the viewport height stays stable, blank when there's nothing to flag */}
      <Text color="yellow">{connHint || " "}</Text>

      <LedgerView ledger={client.ledger} />

      {/* one fixed line so the viewport height stays stable */}
      <Text color="gray">
        {win.hiddenAbove > 0
          ? `  ↑ ${win.hiddenAbove} earlier${win.hiddenBelow > 0 ? ` · ↓ ${win.hiddenBelow} newer` : ""} · PgUp/PgDn`
          : " "}
      </Text>

      <Box flexDirection="column" paddingY={1}>
        {entries.length === 0 ? (
          <Text color="gray">no messages yet — say something, or /help for thread commands</Text>
        ) : (
          visible.map((e) => (
            <Text key={e.id}>
              <Text color={colorFor(e.author)}>{e.author}</Text>
              <Text color="gray"> │ </Text>
              {e.value}
            </Text>
          ))
        )}
      </Box>

      {/* one fixed line, blank when there's no notice */}
      <Text color="yellow">{notice || " "}</Text>
      <Box borderStyle="round" borderColor={status === "denied" ? "red" : "gray"} paddingX={1}>
        {status === "denied" ? (
          <Text color="gray">room denied — nothing typed here can send · esc to quit</Text>
        ) : (
          <>
            <Text color={colorFor(client.handle)}>{client.handle} ▸ </Text>
            {(() => {
              const display = maskForDisplay(line.value); // masks a /key secret on screen only
              return (
                <>
                  <Text>{display.slice(0, line.cursor)}</Text>
                  <Text inverse>{display[line.cursor] ?? " "}</Text>
                  <Text>{display.slice(line.cursor + 1)}</Text>
                </>
              );
            })()}
          </>
        )}
      </Box>
      <Text color="gray"> enter: send · ↑↓ history · ←→ move · PgUp/PgDn scroll · esc: quit · /agent to add an AI · /help</Text>
    </Box>
  );
}

export interface RoomViewProps {
  relayUrl: string;
  room: string;
  handle: string;
  key?: string;
  resolver?: MergeResolver;
}

export function runTui({ relayUrl, room, handle, key, resolver }: RoomViewProps): void {
  const client = new RoomClient(relayUrl, room, handle, key);
  client.connect();
  render(<App client={client} resolver={resolver} />);
}
