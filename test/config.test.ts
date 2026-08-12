// Headless proof of the M5 credential store: save/load round-trip, provider
// resolution from the store, and env-over-store precedence. No TTY, no network.
// Run with `npm run test:config`.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway dir before importing modules that read it.
const dir = mkdtempSync(join(tmpdir(), "quorum-cfg-"));
process.env.QUORUM_CONFIG_DIR = dir;

const { saveStore, loadStore, credentialsPath } = await import("../src/config/store.js");
const { loadCredentials } = await import("../src/config/credentials.js");
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
