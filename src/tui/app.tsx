// The terminal chat window — the "friends window". Renders the converged
// surface, the participant list (humans and AI seats alike), a submit line, and
// inline permission prompts when an AI participant wants to use a tool.
//
// M1: build with Ink (React for the terminal), reusing the React model from the
// sibling repo's components. Placeholder below fixes the props shape.

export interface RoomViewProps {
  room: string;
  handle: string;
  relayUrl: string;
}

export function runTui(_props: RoomViewProps): never {
  throw new Error("runTui(): implemented in M1 (Ink)");
}
