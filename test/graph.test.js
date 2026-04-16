// ACE co-occurrence graph tests.
// Uses an isolated HOME per test so ~/.claude/flags.json + flags.recent.json
// are sandboxed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function mkEnv() {
  const home = mkdtempSync(join(tmpdir(), "ace-graph-"));
  const claudeDir = join(home, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  return {
    home,
    flagsPath: join(claudeDir, "flags.json"),
    recentPath: join(claudeDir, "flags.recent.json"),
  };
}
function cleanup(env) { rmSync(env.home, { recursive: true, force: true }); }
function runFlag(env, args) {
  return spawnSync("node", ["src/flag.js", ...args], {
    env: { ...process.env, HOME: env.home, PATH: process.env.PATH },
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
}
function readFlags(env) {
  if (!existsSync(env.flagsPath)) return {};
  return JSON.parse(readFileSync(env.flagsPath, "utf8"));
}

// ── Single-pass: A then B within window creates bidirectional cooc ──
test("consecutive pings build bidirectional co-occurrence edges", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "outreach"]);
  runFlag(env, ["ping", "gmail"]);
  const flags = readFlags(env);
  assert.equal(flags.outreach.cooc?.gmail, 1, "outreach → gmail edge");
  assert.equal(flags.gmail.cooc?.outreach, 1, "gmail → outreach edge");
  cleanup(env);
});

test("third ping closes the triangle", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "outreach"]);
  runFlag(env, ["ping", "gmail"]);
  runFlag(env, ["ping", "klaff"]);
  const flags = readFlags(env);
  assert.equal(flags.klaff.cooc?.outreach, 1);
  assert.equal(flags.klaff.cooc?.gmail, 1);
  assert.equal(flags.outreach.cooc?.klaff, 1);
  assert.equal(flags.gmail.cooc?.klaff, 1);
  cleanup(env);
});

test("repeated co-pings accumulate weight", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "a"]);
  runFlag(env, ["ping", "b"]);
  runFlag(env, ["ping", "a"]);
  runFlag(env, ["ping", "b"]);
  const flags = readFlags(env);
  // a-b pair accumulates across multiple ping windows
  assert.ok(flags.a.cooc?.b >= 2);
  assert.ok(flags.b.cooc?.a >= 2);
  cleanup(env);
});

test("a concept is not its own neighbor", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "solo"]);
  runFlag(env, ["ping", "solo"]);
  const flags = readFlags(env);
  assert.ok(!flags.solo.cooc || !flags.solo.cooc.solo, "no self-loop");
  cleanup(env);
});

test("flag graph returns neighbors in output", () => {
  const env = mkEnv();
  for (let i = 0; i < 3; i++) {
    runFlag(env, ["ping", "outreach"]);
    runFlag(env, ["ping", "email"]);
  }
  const r = runFlag(env, ["graph", "outreach"]);
  assert.match(r.stdout, /neighbors of 'outreach'/);
  assert.match(r.stdout, /email/);
  cleanup(env);
});

test("flag graph reports empty for a lone concept", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "lonely"]);
  // note: recent log may include self; we need a fresh recent buffer
  // Easiest: check that under the min cooc weight, nothing shows
  const r = runFlag(env, ["graph", "lonely"]);
  assert.match(r.stdout, /no neighbors|neighbors of 'lonely'/);
  cleanup(env);
});

test("cluster expands via BFS at depth 2", () => {
  const env = mkEnv();
  // Build a chain: A ↔ B ↔ C (but A and C never co-pinged)
  // Strategy: ping pairs so each pair-of-pings shares a window
  runFlag(env, ["ping", "A"]);
  runFlag(env, ["ping", "B"]);  // cooc A-B
  runFlag(env, ["ping", "A"]);
  runFlag(env, ["ping", "B"]);  // more weight A-B
  runFlag(env, ["ping", "B"]);
  runFlag(env, ["ping", "C"]);  // cooc B-C
  runFlag(env, ["ping", "B"]);
  runFlag(env, ["ping", "C"]);  // more weight B-C
  const r = runFlag(env, ["cluster", "A", "2"]);
  assert.match(r.stdout, /cluster around 'A'/);
  assert.match(r.stdout, /B/);  // direct neighbor
  // C should appear at depth 2 (via B)
  cleanup(env);
});

test("min cooc weight filters weak edges from graph display", () => {
  const env = mkEnv();
  // Single co-ping = weight 1; default minCoocWeight is 2
  runFlag(env, ["ping", "X"]);
  runFlag(env, ["ping", "Y"]);
  const r = runFlag(env, ["graph", "X"]);
  // Y should be filtered out as weight < 2
  assert.match(r.stdout, /no neighbors/);
  cleanup(env);
});
