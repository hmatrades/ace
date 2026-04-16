// ACE notes + router tests.
// Uses isolated HOME so ~/.claude/notes/ is sandboxed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function mkEnv() {
  const home = mkdtempSync(join(tmpdir(), "ace-notes-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return { home, notesDir: join(home, ".claude", "notes") };
}
function cleanup(env) { rmSync(env.home, { recursive: true, force: true }); }
function runFlag(env, args, stdin) {
  return spawnSync("node", ["src/flag.js", ...args], {
    env: { ...process.env, HOME: env.home, PATH: process.env.PATH },
    input: stdin,
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
}

// We test notes.js + router.js by calling their APIs directly from a child
// node process with HOME overridden, so the store.js path constants resolve
// into the sandboxed directory.
function callNode(env, code) {
  return spawnSync("node", ["--input-type=module", "-e", code], {
    env: { ...process.env, HOME: env.home, PATH: process.env.PATH },
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
}

test("slugify normalizes to filesystem-safe name", async () => {
  const env = mkEnv();
  const r = callNode(env, `
    import { slugify } from "./src/notes.js";
    console.log(slugify("Stripe API Key Rotation! #2"));
  `);
  assert.equal(r.stdout.trim(), "stripe_api_key_rotation_2");
  cleanup(env);
});

test("writeNote creates file with frontmatter + facts", () => {
  const env = mkEnv();
  callNode(env, `
    import { writeNote } from "./src/notes.js";
    writeNote("stripe_rotation", {
      meta: { linked_flag: "stripe_api_keys" },
      facts: ["rotates every 90 days", "last rotated 2026-03-01"],
    });
  `);
  assert.ok(existsSync(join(env.notesDir, "stripe_rotation.md")));
  const raw = readFileSync(join(env.notesDir, "stripe_rotation.md"), "utf8");
  assert.match(raw, /linked_flag:\s*stripe_api_keys/);
  assert.match(raw, /- rotates every 90 days/);
  assert.match(raw, /- last rotated 2026-03-01/);
  cleanup(env);
});

test("readNote round-trips facts", () => {
  const env = mkEnv();
  const r = callNode(env, `
    import { writeNote, readNote } from "./src/notes.js";
    writeNote("x", { meta: {linked_flag: "x"}, facts: ["a", "b"] });
    const got = readNote("x");
    console.log(JSON.stringify({facts: got.facts, link: got.meta.linked_flag}));
  `);
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepEqual(parsed.facts, ["a", "b"]);
  assert.equal(parsed.link, "x");
  cleanup(env);
});

test("writeNote deduplicates facts on merge", () => {
  const env = mkEnv();
  const r = callNode(env, `
    import { writeNote, readNote } from "./src/notes.js";
    writeNote("x", { facts: ["rotates every 90 days"] });
    writeNote("x", { facts: ["rotates every 90 days", "extra fact"] });
    console.log(JSON.stringify(readNote("x").facts));
  `);
  const facts = JSON.parse(r.stdout.trim());
  assert.equal(facts.length, 2);
  assert.ok(facts.includes("rotates every 90 days"));
  assert.ok(facts.includes("extra fact"));
  cleanup(env);
});

test("router.ingest pings concepts and writes note linked to primary", () => {
  const env = mkEnv();
  const r = callNode(env, `
    import { ingest } from "./src/router.js";
    import { loadFlags } from "./src/store.js";
    const result = ingest({
      concepts: ["stripe_api_keys", "key_rotation"],
      facts: ["rotates every 90 days"]
    }, { source: "test obs" });
    const flags = loadFlags();
    console.log(JSON.stringify({
      pinged: result.pinged,
      notes: result.notes,
      primaryHits: flags.stripe_api_keys.hits,
      primaryNoteLink: flags.stripe_api_keys.note,
    }));
  `);
  const out = JSON.parse(r.stdout.trim());
  assert.deepEqual(out.pinged, ["stripe_api_keys", "key_rotation"]);
  assert.deepEqual(out.notes, ["stripe_api_keys"]);
  assert.equal(out.primaryHits, 1);
  assert.equal(out.primaryNoteLink, "stripe_api_keys");
  cleanup(env);
});

test("router.ingest handles concepts without facts", () => {
  const env = mkEnv();
  const r = callNode(env, `
    import { ingest } from "./src/router.js";
    const result = ingest({ concepts: ["gmail_api"], facts: [] });
    console.log(JSON.stringify(result));
  `);
  const out = JSON.parse(r.stdout.trim());
  assert.deepEqual(out.pinged, ["gmail_api"]);
  assert.deepEqual(out.notes, []);
  cleanup(env);
});

test("flag note command reads an existing note", () => {
  const env = mkEnv();
  callNode(env, `
    import { writeNote } from "./src/notes.js";
    writeNote("x", { meta: {linked_flag: "x"}, facts: ["fact one"] });
  `);
  const r = runFlag(env, ["note", "x"]);
  assert.match(r.stdout, /x:/);
  assert.match(r.stdout, /fact one/);
  cleanup(env);
});

test("flag notes lists all notes", () => {
  const env = mkEnv();
  callNode(env, `
    import { writeNote } from "./src/notes.js";
    writeNote("a", { facts: ["x"] });
    writeNote("b", { facts: ["y"] });
  `);
  const r = runFlag(env, ["notes"]);
  assert.match(r.stdout, /\ba\b/);
  assert.match(r.stdout, /\bb\b/);
  cleanup(env);
});
