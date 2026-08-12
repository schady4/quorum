// First-run credential setup: walk the registered providers, ask which to
// enable, and prompt for each one's declared credentials — secrets masked.
// Everything is written to the local store (owner-only). This is the whole
// "one-click install with prompts for credentials" flow: it reads each
// adapter's `credentials`, so a new provider needs no changes here.

import { providers } from "../providers/index.js";
import { loadStore, saveStore } from "./store.js";

const ETX = String.fromCharCode(3); // ctrl-c
const DEL = String.fromCharCode(127); // backspace on most terminals
const BS = String.fromCharCode(8);

/** Read one line in raw mode so secrets can be masked. TTY only. */
function readLine(prompt: string, { mask = false }: { mask?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let val = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === ETX) {
          stdout.write("\n");
          process.exit(130);
        } else if (ch === DEL || ch === BS) {
          if (val.length) {
            val = val.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          val += ch;
          stdout.write(mask ? "*" : ch);
        }
      }
    };
    function done(): void {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      resolve(val);
    }
    stdin.on("data", onData);
  });
}

export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(
      "quorum setup needs an interactive terminal.\n" +
        "Alternatively, set each provider's keys as environment variables — see `quorum providers`.",
    );
    process.exit(1);
  }

  const store = loadStore();
  console.log("quorum setup — configure model providers.");
  console.log("Keys are stored locally only, readable just by you, and sent straight to each provider.\n");

  for (const p of providers) {
    const alreadySet = p.credentials.every((c) => !c.required || store[c.key]);
    const ans = (await readLine(`Enable ${p.label}?${alreadySet ? " [already set — Y/n]" : " [y/N]"} `)).trim().toLowerCase();
    const wants = alreadySet ? ans !== "n" && ans !== "no" : ans === "y" || ans === "yes";
    if (!wants) continue;

    for (const c of p.credentials) {
      const existing = store[c.key];
      const suffix = existing ? " [saved — Enter to keep]" : c.required ? "" : " [optional — Enter to skip]";
      const val = (await readLine(`  ${c.label}${suffix}: `, { mask: c.secret })).trim();
      if (val) store[c.key] = val;
      else if (!existing && c.required) console.log(`  · left ${c.key} unset — ${p.id} won't work until it's provided`);
    }
    console.log("");
  }

  const path = saveStore(store);
  console.log(`Saved ${Object.keys(store).length} value(s) to ${path}`);
  console.log("Next:  quorum host   ·   quorum join <room> --as you   ·   quorum agent <room> --provider <id>");
}
