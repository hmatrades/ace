// ACE flag memory — core test suite
// Tests decay math, stance thresholds, CRUD, persistence, pipe integration
// These tests use an isolated store path so they don't pollute live flags.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ── Test harness ──
// We spawn the flag CLI with HOME pointing at a temp dir so flags.json is isolated.
function mkEnv() {
  const home = mkdtempSync(join(tmpdir(), "ace-test-"));
  const claudeDir = join(home, ".claude");
  spawnSync("mkdir", ["-p", claudeDir]);
  return { home, flagsPath: join(claudeDir, "flags.json") };
}

function cleanup(env) {
  rmSync(env.home, { recursive: true, force: true });
}

function runFlag(env, args, stdin) {
  const r = spawnSync("node", ["src/flag.js", ...args], {
    env: { ...process.env, HOME: env.home, PATH: process.env.PATH },
    input: stdin,
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function writeFlags(env, obj) {
  writeFileSync(env.flagsPath, JSON.stringify(obj, null, 2));
}
function readFlags(env) {
  if (!existsSync(env.flagsPath)) return {};
  return JSON.parse(readFileSync(env.flagsPath, "utf8"));
}

const dayNow = () => Math.floor(Date.now() / 86400000);

// ── CLI behavior tests ──

test("ping creates new flag with default half-life", () => {
  const env = mkEnv();
  const r = runFlag(env, ["ping", "alpha"]);
  assert.equal(r.status, 0);
  const flags = readFlags(env);
  assert.equal(flags.alpha.hits, 1);
  assert.equal(flags.alpha.hl, 21);
  assert.equal(flags.alpha.seen, dayNow());
  cleanup(env);
});

test("ping increments existing flag", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "alpha"]);
  runFlag(env, ["ping", "alpha"]);
  runFlag(env, ["ping", "alpha"]);
  assert.equal(readFlags(env).alpha.hits, 3);
  cleanup(env);
});

test("ping accepts custom half-life", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "deep", "90"]);
  assert.equal(readFlags(env).deep.hl, 90);
  cleanup(env);
});

test("ping does not overwrite half-life on re-ping", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "deep", "90"]);
  runFlag(env, ["ping", "deep"]); // no hl arg
  assert.equal(readFlags(env).deep.hl, 90);
  cleanup(env);
});

test("recall returns stance for existing flag", () => {
  const env = mkEnv();
  for (let i = 0; i < 10; i++) runFlag(env, ["ping", "strong_concept"]);
  const r = runFlag(env, ["recall", "strong_concept"]);
  assert.match(r.stdout, /hits:\s+10/);
  assert.match(r.stdout, /stance:\s+strong/);
  cleanup(env);
});

test("recall reports no flag for missing concept", () => {
  const env = mkEnv();
  const r = runFlag(env, ["recall", "nope"]);
  assert.match(r.stdout, /no flag/);
  cleanup(env);
});

test("eff returns 0 for missing concept", () => {
  const env = mkEnv();
  const r = runFlag(env, ["eff", "nope"]);
  assert.equal(r.stdout.trim(), "0");
  cleanup(env);
});

test("top ranks by effective salience (decayed)", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, {
    fresh: { hits: 10, seen: now, hl: 21 },
    stale: { hits: 20, seen: now - 42, hl: 21 }, // 20 * 0.5^2 = 5
    older: { hits: 30, seen: now - 21, hl: 21 }, // 30 * 0.5 = 15
  });
  const r = runFlag(env, ["top"]);
  const lines = r.stdout.split("\n").filter((l) => /^\s+\w/.test(l) && !/concept|—/.test(l));
  // Expect ranking: older(15) > fresh(10) > stale(5)
  assert.match(lines[0], /older/);
  assert.match(lines[1], /fresh/);
  assert.match(lines[2], /stale/);
  cleanup(env);
});

test("decay: 1 half-life reduces to 50%", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, { x: { hits: 16, seen: now - 21, hl: 21 } });
  const r = runFlag(env, ["eff", "x"]);
  assert.equal(Number(r.stdout.trim()), 8.0);
  cleanup(env);
});

test("decay: 2 half-lives reduces to 25%", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, { x: { hits: 16, seen: now - 42, hl: 21 } });
  const r = runFlag(env, ["eff", "x"]);
  assert.equal(Number(r.stdout.trim()), 4.0);
  cleanup(env);
});

test("decay: 4 half-lives reduces to ~6%", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, { x: { hits: 16, seen: now - 84, hl: 21 } });
  const r = runFlag(env, ["eff", "x"]);
  assert.equal(Number(r.stdout.trim()), 1.0);
  cleanup(env);
});

test("stance thresholds: strong ≥ 8", () => {
  const env = mkEnv();
  writeFlags(env, { s: { hits: 8, seen: dayNow(), hl: 21 } });
  const r = runFlag(env, ["recall", "s"]);
  assert.match(r.stdout, /stance:\s+strong/);
  cleanup(env);
});

test("stance thresholds: familiar [3, 8)", () => {
  const env = mkEnv();
  writeFlags(env, { f: { hits: 5, seen: dayNow(), hl: 21 } });
  const r = runFlag(env, ["recall", "f"]);
  assert.match(r.stdout, /stance:\s+familiar/);
  cleanup(env);
});

test("stance thresholds: light [1, 3)", () => {
  const env = mkEnv();
  writeFlags(env, { l: { hits: 2, seen: dayNow(), hl: 21 } });
  const r = runFlag(env, ["recall", "l"]);
  assert.match(r.stdout, /stance:\s+light/);
  cleanup(env);
});

test("stance thresholds: faded < 1", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, { fa: { hits: 2, seen: now - 42, hl: 21 } }); // eff ~0.5
  const r = runFlag(env, ["recall", "fa"]);
  assert.match(r.stdout, /stance:\s+faded/);
  cleanup(env);
});

test("prune removes only decayed flags", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, {
    alive: { hits: 10, seen: now, hl: 21 },
    dead1: { hits: 1, seen: now - 100, hl: 7 },
    dead2: { hits: 1, seen: now - 200, hl: 7 },
  });
  const r = runFlag(env, ["prune"]);
  assert.match(r.stdout, /removed 2/);
  const after = readFlags(env);
  assert.ok(after.alive);
  assert.ok(!after.dead1);
  assert.ok(!after.dead2);
  cleanup(env);
});

test("prune reports nothing when all fresh", () => {
  const env = mkEnv();
  writeFlags(env, { a: { hits: 10, seen: dayNow(), hl: 21 } });
  const r = runFlag(env, ["prune"]);
  assert.match(r.stdout, /nothing to prune/);
  cleanup(env);
});

test("export produces valid JSON of current state", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "a"]);
  runFlag(env, ["ping", "b"]);
  const r = runFlag(env, ["export"]);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.a);
  assert.ok(parsed.b);
  cleanup(env);
});

test("import restores flags from JSON", () => {
  const env = mkEnv();
  const now = dayNow();
  const payload = JSON.stringify({
    imported: { hits: 5, seen: now, hl: 21 },
  });
  const r = runFlag(env, ["import"], payload);
  assert.match(r.stdout, /imported 1 flags/);
  assert.equal(readFlags(env).imported.hits, 5);
  cleanup(env);
});

test("clear wipes all flags", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "a"]);
  runFlag(env, ["ping", "b"]);
  runFlag(env, ["clear"]);
  assert.deepEqual(readFlags(env), {});
  cleanup(env);
});

test("concepts coerce to string", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "42"]);
  assert.ok(readFlags(env)["42"]);
  cleanup(env);
});

test("ping refreshes seen timestamp", () => {
  const env = mkEnv();
  const now = dayNow();
  writeFlags(env, { old: { hits: 5, seen: now - 10, hl: 21 } });
  runFlag(env, ["ping", "old"]);
  assert.equal(readFlags(env).old.seen, now);
  assert.equal(readFlags(env).old.hits, 6);
  cleanup(env);
});

test("simulate returns decay curve", () => {
  const env = mkEnv();
  runFlag(env, ["ping", "x", "21"]);
  runFlag(env, ["ping", "x"]);
  runFlag(env, ["ping", "x"]);
  const r = runFlag(env, ["simulate", "x", "60"]);
  assert.match(r.stdout, /day\s+0/);
  assert.match(r.stdout, /day\s+60/);
  cleanup(env);
});

test("help shows when no command given", () => {
  const env = mkEnv();
  const r = runFlag(env, []);
  assert.match(r.stdout, /flag — ACE salience pointers/);
  assert.match(r.stdout, /ping/);
  assert.match(r.stdout, /recall/);
  assert.match(r.stdout, /graph/);
  cleanup(env);
});
