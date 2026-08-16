// The terminal chat window — the "friends window". Renders the converged
// message stream, the participant roster, the DAG decision-ledger (trunk +
// branches + recent history), and a submit line. Humans and AI participants
// appear the same way; a seat is a seat.
//
// The input line doubles as a command line: lines starting with "/" drive the
// ledger (fork / set / merge); everything else is a chat message. The view is a
// pure function of the RoomClient's converged CRDT + ledger state.

import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import type { Entry } from "../core/crdt.js";
import type { Ledger, MergeResolver } from "../core/ledger.js";
import { RoomClient } from "../net/client.js";
import { type Line, EMPTY, fromValue, insert, backspace, del, left, right, home, end, pushHistory, historyValue } from "./lineedit.js";
import { windowFor, clampOffset } from "./viewport.js";

const PALETTE = ["cyan", "yellow", "green", "magenta", "blue", "red"] as const;
function colorFor(author: string): (typeof PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
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

  // ↑/↓ command history, with the live draft stashed while recalling.
  const [history, setHistory] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState(0);
  const draftStash = useRef("");

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
    const onOpen = () => setStatus("online");
    const onReconnecting = () => setStatus("reconnecting");
    const onDenied = (reason: string) => {
      setStatus("denied");
      setNotice(`join denied: ${reason} — check the room key (--key)`);
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
      } else if (cmd === "help") {
        setNotice("/fork [names] · /set <branch> <key> <value> · /merge <a> <b>");
      } else {
        setNotice(`unknown command: /${cmd}`);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // Size the message viewport to whatever rows are left after the fixed chrome
  // (header 3 · ledger · scroll hint 1 · message padding 2 · notice 1 · input 3
  // · footer 1), then take the visible slice.
  const viewportRows = Math.max(3, rows - (11 + ledgerHeight(client.ledger)));
  viewportRef.current = viewportRows;
  const win = windowFor(entries.length, viewportRows, offset);
  const visible = entries.slice(win.start, win.end);

  useInput((input, key) => {
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
            {status === "denied"
              ? "denied"
              : status === "reconnecting"
                ? "reconnecting…"
                : status === "connecting"
                  ? "connecting…"
                  : participants.length
                    ? participants.join(", ")
                    : "…"}
          </Text>
        </Text>
      </Box>

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
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={colorFor(client.handle)}>{client.handle} ▸ </Text>
        <Text>{line.value.slice(0, line.cursor)}</Text>
        <Text inverse>{line.value[line.cursor] ?? " "}</Text>
        <Text>{line.value.slice(line.cursor + 1)}</Text>
      </Box>
      <Text color="gray"> enter: send · ↑↓ history · ←→ move · PgUp/PgDn scroll · esc: quit</Text>
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
