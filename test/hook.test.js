// ACE plugin hook tests — verifies JSON output contract.
// Tests in isolation so live flags aren't read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function mkEnv(flagState = {}) {
  const home = mkdtempSync(join(tmpdir(), "ace-hook-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "flags.json"), JSON.stringify(flagState, null, 2));
  return home;
}

function runHook(home, mode, stdin) {
  return spawnSync("node", ["plugin/hooks/ace-hook.js", mode], {
    env: { ...process.env, HOME: home, PATH: process.env.PATH },
    input: stdin || "",
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
}

const day = Math.floor(Date.now() / 86400000);

test("context mode emits Claude Code hook JSON schema", () => {
  const home = mkEnv({
    outreach: { hits: 20, seen: day, hl: 21 },
    email: { hits: 5, seen: day, hl: 21 },
  });
  const r = runHook(home, "context");
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /\$ACE/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /outreach/);
  rmSync(home, { recursive: true, force: true });
});

test("context mode handles empty flags gracefully", () => {
  const home = mkEnv({});
  const r = runHook(home, "context");
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /no flags yet/);
  rmSync(home, { recursive: true, force: true });
});

test("context mode includes stance markers and cluster section", () => {
  const home = mkEnv({
    strongone: { hits: 10, seen: day, hl: 21 },
    familiar1: { hits: 5, seen: day, hl: 21 },
    light1: { hits: 2, seen: day, hl: 21 },
  });
  const r = runHook(home, "context");
  const body = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(body, /● strongone/);
  assert.match(body, /◐ familiar1/);
  assert.match(body, /○ light1/);
  assert.match(body, /Association clusters/);
  assert.match(body, /Engagement posture/);
  rmSync(home, { recursive: true, force: true });
});

test("context mode output stays under 2KB with realistic flag count", () => {
  const home = mkEnv(
    Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `concept_${i}`,
        { hits: 10 - Math.floor(i / 10), seen: day, hl: 21 },
      ])
    )
  );
  const r = runHook(home, "context");
  const parsed = JSON.parse(r.stdout);
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.length < 2048,
    `context was ${parsed.hookSpecificOutput.additionalContext.length} bytes, expected <2048`
  );
  rmSync(home, { recursive: true, force: true });
});

test("user-prompt mode returns continue signal without crashing", () => {
  const home = mkEnv({ outreach: { hits: 5, seen: day, hl: 21 } });
  const r = runHook(home, "user-prompt", JSON.stringify({ prompt: "tell me about outreach" }));
  // Hook may exit 0 even if ping side-effect fails (optional)
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.continue, true);
  rmSync(home, { recursive: true, force: true });
});

test("user-prompt mode pings matched concepts in-process (batched)", () => {
  const home = mkEnv({
    outreach: { hits: 5, seen: day, hl: 21 },
    gmail_api: { hits: 3, seen: day, hl: 21 },
    never_mentioned: { hits: 2, seen: day, hl: 21 },
  });
  const r = runHook(
    home,
    "user-prompt",
    JSON.stringify({ prompt: "kicking off outreach with gmail_api today" })
  );
  assert.equal(r.status, 0);
  const flagsPath = join(home, ".claude", "flags.json");
  const flags = JSON.parse(readFileSync(flagsPath, "utf8"));
  assert.equal(flags.outreach.hits, 6, "matched concept should increment");
  assert.equal(flags.gmail_api.hits, 4, "second matched concept should increment");
  assert.equal(flags.never_mentioned.hits, 2, "unmatched concept stays put");
  rmSync(home, { recursive: true, force: true });
});

test("unknown mode exits non-zero", () => {
  const home = mkEnv({});
  const r = runHook(home, "bogus");
  assert.notEqual(r.status, 0);
  rmSync(home, { recursive: true, force: true });
});
