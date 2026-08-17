// Credential setup: walk the registered providers, ask which to enable, and
// prompt for each one's declared credentials — secrets masked. Everything is
// written to the local store (owner-only). This is the whole "one-click
// install with prompts for credentials" flow: it reads each adapter's
// `credentials`, so a new provider needs no changes here.
//
// Every value entered is live-checked with one minimal real call before it's
// trusted, so a bad or out-of-funds key is caught here instead of failing
// silently on an AI seat's first @mention. `--status` / `--unset <provider>` /
// `--wipe` cover the rest of the lifecycle: see what's configured, drop one
// provider, or nuke the whole store and start clean.

import { providers } from "../providers/index.js";
import { loadStore, saveStore, wipeStore, credentialsPath } from "./store.js";
import { missingRequired, testProvider } from "./credentials.js";

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

/** Mask a stored value down to its last 4 chars, e.g. "sk-ant-…7f2a". Never
 *  echo a full secret back, even to its own owner, in --status output. */
function mask(v: string): string {
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}

function printStatus(): void {
  const store = loadStore();
  console.log(`Provider credentials — ${credentialsPath()}\n`);
  for (const p of providers) {
    console.log(`${p.id.padEnd(10)} ${p.label}`);
    for (const c of p.credentials) {
      const v = store[c.key];
      const state = v ? mask(v) : c.required ? "not set (required)" : "not set (optional)";
      console.log(`  ${c.key.padEnd(20)} ${state}`);
    }
  }
  console.log("\nFix or add a key:   quorum setup");
  console.log("Remove one provider: quorum setup --unset <provider>");
  console.log("Start over:          quorum setup --wipe");
}

function unsetProvider(id: string | undefined): void {
  const provider = id ? providers.find((p) => p.id === id) : undefined;
  if (!provider) {
    console.error(`Usage: quorum setup --unset <provider>`);
    console.error(`Known providers: ${providers.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }
  const store = loadStore();
  let removed = 0;
  for (const c of provider.credentials) {
    if (c.key in store) {
      delete store[c.key];
      removed++;
    }
  }
  saveStore(store);
  console.log(removed ? `Removed ${removed} value(s) for ${provider.label}.` : `Nothing was set for ${provider.label} already.`);
}

async function wipe(skipConfirm: boolean): Promise<void> {
  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      console.error("This deletes every saved credential. Rerun with --yes to confirm non-interactively.");
      process.exit(1);
    }
    const ans = (
      await readLine(`This deletes ALL saved provider credentials at ${credentialsPath()}. Continue? [y/N] `)
    )
      .trim()
      .toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      console.log("Cancelled — nothing was changed.");
      return;
    }
  }
  const path = wipeStore();
  console.log(`Wiped ${path}. Run \`quorum setup\` whenever you're ready to reconfigure.`);
}

export async function runSetup(args: string[] = []): Promise<void> {
  if (args.includes("--status")) return printStatus();
  if (args.includes("--wipe")) return wipe(args.includes("--yes"));
  const unsetAt = args.indexOf("--unset");
  if (unsetAt !== -1) return unsetProvider(args[unsetAt + 1]);

  if (!process.stdin.isTTY) {
    console.error(
      "quorum setup needs an interactive terminal.\n" +
        "Alternatively, set each provider's keys as environment variables — see `quorum providers`,\n" +
        "or use `quorum setup --status` / `--unset <provider>` / `--wipe` non-interactively.",
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
      const suffix = existing ? " [saved — Enter to keep, - to clear]" : c.required ? "" : " [optional — Enter to skip]";
      const val = (await readLine(`  ${c.label}${suffix}: `, { mask: c.secret })).trim();
      if (val === "-" && existing) {
        delete store[c.key];
        console.log(`    · cleared ${c.key}`);
      } else if (val) {
        store[c.key] = val;
      } else if (!existing && c.required) {
        console.log(`  · left ${c.key} unset — ${p.id} won't work until it's provided`);
      }
    }

    // Know now, not on first @mention: fire a real minimal call as soon as we
    // have a complete set of required credentials, so a bad or out-of-funds
    // key doesn't sit silently in the store until an AI seat trips over it.
    const creds: Record<string, string> = {};
    for (const c of p.credentials) if (store[c.key]) creds[c.key] = store[c.key];
    if (missingRequired(p, creds).length === 0) {
      process.stdout.write("  checking key… ");
      const result = await testProvider(p, creds);
      if (result.ok) {
        console.log("✓ looks good");
      } else {
        console.log(`✗ ${result.message}`);
        const ans2 = (await readLine("  Keep it anyway, or clear it? [keep/clear] (clear) ")).trim().toLowerCase();
        if (ans2 !== "keep" && ans2 !== "k") {
          for (const c of p.credentials) delete store[c.key];
          console.log(`  · cleared ${p.id} — rerun \`quorum setup\` to try again`);
        }
      }
    }
    console.log("");
  }

  const path = saveStore(store);
  console.log(`Saved ${Object.keys(store).length} value(s) to ${path}`);
  console.log("Next:  quorum host   ·   quorum join <room> --as you   ·   quorum agent <room> --provider <id>");
}
