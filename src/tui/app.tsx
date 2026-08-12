// The terminal chat window — the "friends window". Renders the converged
// message stream, the participant roster, and a submit line. Humans and (from
// M2) AI participants appear the same way; a seat is a seat.
//
// Built with Ink (React for the terminal). The view is a pure function of the
// RoomClient's converged CRDT state — it never orders messages itself.

import React, { useEffect, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import type { Entry } from "../core/crdt.js";
import { RoomClient } from "../net/client.js";

const PALETTE = ["cyan", "yellow", "green", "magenta", "blue", "red"] as const;
function colorFor(author: string): (typeof PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function App({ client }: { client: RoomClient }) {
  const app = useApp();
  const [entries, setEntries] = useState<Entry[]>(client.entries());
  const [participants, setParticipants] = useState<string[]>(client.participants);
  const [draft, setDraft] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const onUpdate = (e: Entry[]) => setEntries([...e]);
    const onPresence = (p: string[]) => setParticipants([...p]);
    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    client.on("update", onUpdate);
    client.on("presence", onPresence);
    client.on("open", onOpen);
    client.on("close", onClose);
    return () => {
      client.off("update", onUpdate);
      client.off("presence", onPresence);
      client.off("open", onOpen);
      client.off("close", onClose);
    };
  }, [client]);

  useInput((input, key) => {
    if (key.return) {
      const text = draft.trim();
      if (text) {
        client.send(text);
        setDraft("");
      }
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
        <Text color="gray">
          {connected ? "●" : "○"} {participants.length ? participants.join(", ") : "connecting…"}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingY={1}>
        {entries.length === 0 ? (
          <Text color="gray">no messages yet — say something, or wait for the room</Text>
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

      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={colorFor(client.handle)}>{client.handle} ▸ </Text>
        <Text>{draft}</Text>
        <Text color="gray">▍</Text>
      </Box>
      <Text color="gray"> enter: send · esc: quit</Text>
    </Box>
  );
}

export interface RoomViewProps {
  relayUrl: string;
  room: string;
  handle: string;
}

export function runTui({ relayUrl, room, handle }: RoomViewProps): void {
  const client = new RoomClient(relayUrl, room, handle);
  client.connect();
  render(<App client={client} />);
}
