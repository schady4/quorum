// Guard: the React Native / browser entry (src/native.ts) must never pull a
// Node-only module into a mobile/web bundle. We statically walk its import
// graph, applying the same `crypto-impl` / `ws-impl` -> `.native` swap the
// bundler does via package.json's "react-native" field, and assert that no
// `node:` builtin survives. If someone imports (say) `../session/store.js` into
// the native barrel, or reaches for `node:events` again in the client, this
// fails long before anyone tries to bundle it on a phone. Run with
// `npm run test:native`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../src");

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Resolve a relative TS import to a real file on disk (bare/`node:` handled by
// the caller). Mirrors the "react-native" field map: the two platform seams
// resolve to their `.native` twin.
function resolveImport(fromFile: string, spec: string): string {
  let target = resolve(dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  target = target.replace(/\/crypto-impl\.ts$/, "/crypto-impl.native.ts");
  target = target.replace(/\/ws-impl\.ts$/, "/ws-impl.native.ts");
  return target;
}

function walk(file: string, seen: Set<string>, nodeHits: string[]): void {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  // Skip type-only statements (`import type … from`, `export type … from`):
  // TypeScript erases them and no bundler emits them, so they can't drag a
  // module into a runtime bundle. Value imports of the platform seams are what
  // matter.
  const re = /(?:import|export)\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) continue; // `import type` / `export type` — erased at compile time
    const spec = m[2] || m[3];
    if (!spec) continue;
    if (spec.startsWith("node:")) {
      nodeHits.push(`${spec}  <- ${file.slice(srcDir.length + 1)}`);
      continue;
    }
    if (spec.startsWith(".")) walk(resolveImport(file, spec), seen, nodeHits);
    // bare npm deps (e.g. @noble/*) are fine and not walked
  }
}

test("the native entry's import graph reaches no `node:` builtin", () => {
  const seen = new Set<string>();
  const nodeHits: string[] = [];
  walk(resolve(srcDir, "native.ts"), seen, nodeHits);
  ok(seen.size > 5, "expected the walk to actually traverse the graph");
  ok(nodeHits.length === 0, `native graph reaches node: builtins:\n      ${nodeHits.join("\n      ")}`);
});

test("the native entry does not import the Node-only save/config/agent modules", () => {
  const seen = new Set<string>();
  walk(resolve(srcDir, "native.ts"), seen, []);
  const forbidden = ["/session/store.ts", "/session/qdag.ts", "/session/torchbearer.ts", "/config/", "/agent/"];
  const leaked = [...seen].filter((f) => forbidden.some((p) => f.includes(p)));
  ok(leaked.length === 0, `native graph pulled Node-only modules:\n      ${leaked.map((f) => f.slice(srcDir.length + 1)).join("\n      ")}`);
});

if (failures.length) {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);
