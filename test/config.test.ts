// Headless proof of the M5 credential store: save/load round-trip, provider
// resolution from the store, and env-over-store precedence. No TTY, no network.
// Run with `npm run test:config`.

import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway dir before importing modules that read it.
const dir = mkdtempSync(join(tmpdir(), "quorum-cfg-"));
process.env.QUORUM_CONFIG_DIR = dir;

const { saveStore, loadStore, wipeStore, credentialsPath } = await import("../src/config/store.js");
const { loadCredentials, missingRequired, testProvider } = await import("../src/config/credentials.js");
const { anthropic } = await import("../src/providers/anthropic.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

try {
  // Round-trip.
  saveStore({ ANTHROPIC_API_KEY: "sk-stored" });
  check("store round-trips", loadStore().ANTHROPIC_API_KEY === "sk-stored");

  // File is owner-only (0600) where the platform supports it.
  const mode = statSync(credentialsPath()).mode & 0o777;
  check("store file is owner-only", process.platform === "win32" || mode === 0o600, mode.toString(8));

  // Provider resolves its declared credential from the store.
  delete process.env.ANTHROPIC_API_KEY;
  check("loadCredentials reads from the store", loadCredentials(anthropic).ANTHROPIC_API_KEY === "sk-stored");

  // Environment overrides the store.
  process.env.ANTHROPIC_API_KEY = "sk-env";
  check("environment overrides the store", loadCredentials(anthropic).ANTHROPIC_API_KEY === "sk-env");
  delete process.env.ANTHROPIC_API_KEY;

  // Only declared keys come back.
  saveStore({ ANTHROPIC_API_KEY: "sk-stored", UNRELATED: "x" });
  const creds = loadCredentials(anthropic);
  check("only declared credentials are returned", creds.ANTHROPIC_API_KEY === "sk-stored" && !("UNRELATED" in creds));

  // Removing one provider's keys (the `quorum setup --unset` path) leaves
  // unrelated keys untouched.
  const afterUnset = loadStore();
  delete afterUnset.ANTHROPIC_API_KEY;
  saveStore(afterUnset);
  check("unsetting a provider drops just its keys", !loadStore().ANTHROPIC_API_KEY && loadStore().UNRELATED === "x");

  // Wiping (the `quorum setup --wipe` path) removes the file entirely.
  saveStore({ ANTHROPIC_API_KEY: "sk-stored" });
  check("credentials file exists before wipe", existsSync(credentialsPath()));
  wipeStore();
  check("wipe deletes the credentials file", !existsSync(credentialsPath()));
  check("wipe on an already-missing file doesn't throw", (wipeStore(), true));
  check("store reads empty after wipe", Object.keys(loadStore()).length === 0);

  // testProvider: a fake adapter, so this stays network-free. A working call
  // reports ok; a failing one surfaces the thrown message so setup can show it.
  const okAdapter = {
    id: "fake-ok",
    label: "Fake (ok)",
    credentials: [],
    listModels: () => [{ id: "fake-cheap", label: "cheap", strengths: ["cheap"] }, { id: "fake-default", label: "default" }],
    generate: async () => ({ text: "OK" }),
  };
  const badAdapter = {
    ...okAdapter,
    id: "fake-bad",
    generate: async () => {
      throw new Error("insufficient credits");
    },
  };
  const noModelAdapter = { ...okAdapter, id: "fake-no-models", listModels: () => [] };

  check("testProvider reports ok on a working call", (await testProvider(okAdapter, {})).ok === true);
  const bad = await testProvider(badAdapter, {});
  check("testProvider surfaces the failure message", bad.ok === false && bad.message === "insufficient credits");
  check("testProvider skips adapters with no listable model", (await testProvider(noModelAdapter, {})).ok === true);
  check("missingRequired stays accurate alongside the new helpers", missingRequired(anthropic, {}).includes("ANTHROPIC_API_KEY"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
