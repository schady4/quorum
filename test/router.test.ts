// Headless proof of the router policy: intent + effort select a model by the
// strengths providers advertise, explicit preferences still win, and an empty
// hint reproduces the old "first registered model" default. No network — the
// registered adapters list their models statically, so route() runs offline.
// Run with `npm run test:router`.

import { route, profileFor, scoreModel, classifyEffort } from "../src/router/index.js";
import type { ModelInfo } from "../src/providers/types.js";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.log(`FAIL  ${name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    });
}

function eq<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n      expected ${e}\n      got      ${a}`);
}

function ok(cond: boolean, msg = "expected true"): void {
  if (!cond) throw new Error(msg);
}

const opus: ModelInfo = { id: "claude-opus-5", label: "Opus", strengths: ["reasoning", "code"] };
const sonnet: ModelInfo = { id: "claude-sonnet-5", label: "Sonnet", strengths: ["general", "speed"] };
const haiku: ModelInfo = { id: "claude-haiku-4-5", label: "Haiku", strengths: ["speed", "cheap"] };
const plain: ModelInfo = { id: "x", label: "X" };

async function main(): Promise<void> {
  // --- profileFor: kind first, effort appended, deduped -------------------
  await test("profileFor: kind drives the profile", () => {
    eq(profileFor({ kind: "arbitrate-merge" }), ["reasoning", "code"]);
  });
  await test("profileFor: effort appends as a tie-breaker, deduped", () => {
    eq(profileFor({ kind: "reasoning", effort: "high" }), ["reasoning", "code"]);
    eq(profileFor({ kind: "chat", effort: "low" }), ["general", "speed", "cheap"]);
  });
  await test("profileFor: empty hint -> empty profile (old default)", () => {
    eq(profileFor({}), []);
  });

  // --- scoreModel: earlier strengths weigh more, no-strength = neutral ----
  await test("scoreModel: top priority beats lesser match", () => {
    const p = ["reasoning", "code"];
    ok(scoreModel(opus, p) > scoreModel(sonnet, p), "opus should outscore sonnet for reasoning");
  });
  await test("scoreModel: empty profile or no strengths scores 0", () => {
    eq(scoreModel(opus, []), 0);
    eq(scoreModel(plain, ["reasoning"]), 0);
  });

  // --- classifyEffort -----------------------------------------------------
  await test("classifyEffort: small talk is low", () => {
    eq(classifyEffort("hey what's up"), "low");
  });
  await test("classifyEffort: code and design questions are high", () => {
    eq(classifyEffort("can you refactor this function for me"), "high");
    eq(classifyEffort("why did we choose the DAG design over a log"), "high");
    eq(classifyEffort("```ts\nconst x = 1\n```"), "high");
  });

  // --- route() over the real registry (offline) ---------------------------
  await test("route: empty hint reproduces first-provider/first-model default", async () => {
    const d = await route({});
    eq(d.provider, "anthropic");
    eq(d.model, "claude-opus-5"); // first adapter, first listed model
  });
  await test("route: arbitrate-merge on anthropic picks the reasoning model", async () => {
    const d = await route({ preferProvider: "anthropic", kind: "arbitrate-merge" });
    eq(d.model, "claude-opus-5");
  });
  await test("route: low-effort chat on anthropic avoids the frontier model", async () => {
    const d = await route({ preferProvider: "anthropic", kind: "chat", effort: "low" });
    ok(d.model !== "claude-opus-5", `expected a non-frontier model, got ${d.model}`);
  });
  await test("route: explicit preferModel is honored verbatim", async () => {
    const d = await route({ preferProvider: "anthropic", preferModel: "claude-haiku-4-5" });
    eq(d.model, "claude-haiku-4-5");
  });
  await test("route: unknown provider throws", async () => {
    let threw = false;
    try {
      await route({ preferProvider: "nope" });
    } catch {
      threw = true;
    }
    ok(threw, "expected route to throw on unknown provider");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

void main();
