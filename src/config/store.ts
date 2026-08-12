// Local credential store. `quorum setup` writes it; `loadCredentials` reads it.
// It lives in the user's home dir (override with QUORUM_CONFIG_DIR), holds only
// the credential values the user chose to save, and is written owner-only. Keys
// never leave the machine — providers are called directly from here.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

export function configDir(): string {
  return process.env.QUORUM_CONFIG_DIR || join(homedir(), ".quorum");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

/** Read the stored credential values (key -> value). Missing file ⇒ empty. */
export function loadStore(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Persist the store, owner-readable only. Returns the path written. */
export function saveStore(store: Record<string, string>): string {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // enforce perms even if the file pre-existed
  } catch {
    /* best effort on platforms without chmod */
  }
  return path;
}
