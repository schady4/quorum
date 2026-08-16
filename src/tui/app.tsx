// The terminal chat window — the "friends window". Renders the converged
// message stream, the participant roster, the DAG decision-ledger (trunk +
// branches + recent history), and a submit line. Humans and AI participants
// appear the same way; a seat is a seat.
//
// The input line doubles as a command line: lines starting with "/" drive the
// ledger (fork / set / merge); everything else is a chat message. The view is a
// pure function of the RoomClient's converged CRDT + ledger state.

import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import type { Entry } from "../core/crdt.js";
import type { Ledger, MergeResolver } from "../core/ledger.js";
import { RoomClient } from "../net/client.js";

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
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<"connecting" | "online" | "reconnecting">("connecting");

  useEffect(() => {
    const onUpdate = (e: Entry[]) => setEntries([...e]);
    const onPresence = (p: string[]) => setParticipants([...p]);
    const onLedger = () => forceLedger((n) => n + 1);
    const onOpen = () => setStatus("online");
    const onReconnecting = () => setStatus("reconnecting");
    client.on("update", onUpdate);
    client.on("presence", onPresence);
    client.on("ledger", onLedger);
    client.on("open", onOpen);
    client.on("reconnecting", onReconnecting);
    return () => {
      client.off("update", onUpdate);
      client.off("presence", onPresence);
      client.off("ledger", onLedger);
      client.off("open", onOpen);
      client.off("reconnecting", onReconnecting);
    };
  }, [client]);

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

  useInput((input, key) => {
    if (key.return) {
      const text = draft.trim();
      if (text.startsWith("/")) runCommand(text);
      else if (text) client.send(text);
      setDraft("");
    } else if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
    } else if (key.escape) {
      client.close();
      app.exit();
    } else if (input && !key.ctrl && !key.meta) {
      setDraft((d) => d + input);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="blueBright">◇ quorum · #{client.room}</Text>
        <Text>
          <Text color={status === "online" ? "green" : status === "reconnecting" ? "yellow" : "gray"}>
            {status === "online" ? "●" : "○"}{" "}
          </Text>
          <Text color="gray">
            {status === "reconnecting"
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

      <Box flexDirection="column" flexGrow={1} paddingY={1}>
        {entries.length === 0 ? (
          <Text color="gray">no messages yet — say something, or /help for thread commands</Text>
        ) : (
          entries.map((e) => (
            <Text key={e.id}>
              <Text color={colorFor(e.author)}>{e.author}</Text>
              <Text color="gray"> │ </Text>
              {e.value}
            </Text>
          ))
        )}
      </Box>

      {notice ? <Text color="yellow">{notice}</Text> : null}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={colorFor(client.handle)}>{client.handle} ▸ </Text>
        <Text>{draft}</Text>
        <Text color="gray">▍</Text>
      </Box>
      <Text color="gray"> enter: send · / for thread commands · esc: quit</Text>
    </Box>
  );
}

export interface RoomViewProps {
  relayUrl: string;
  room: string;
  handle: string;
  resolver?: MergeResolver;
}

export function runTui({ relayUrl, room, handle, resolver }: RoomViewProps): void {
  const client = new RoomClient(relayUrl, room, handle);
  client.connect();
  render(<App client={client} resolver={resolver} />);
}
