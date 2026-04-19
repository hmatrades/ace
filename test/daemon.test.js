// ACE daemon tests — cursor persistence + fetch logic.
// Does NOT hit the real claude-mem DB or LLM backends (those are integration
// concerns). Uses a temp sqlite DB with a fake observations table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

function mkEnv() {
  const home = mkdtempSync(join(tmpdir(), "ace-daemon-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const dbPath = join(home, "test-mem.db");
  // Create minimal claude-mem schema
  execFileSync("sqlite3", [dbPath, `
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      subtitle TEXT,
      created_at_epoch INTEGER
    );
  `]);
  // Write ace.config.json pointing at our test DB
  writeFileSync(join(home, ".claude", "ace.config.json"), JSON.stringify({
    daemon: { pollSeconds: 60, claudemem_db: dbPath },
    extract: { backend: "noop", fallbackChain: [] }, // unknown backend → empty extractions
  }, null, 2));
  return { home, dbPath };
}
function cleanup(env) { rmSync(env.home, { recursive: true, force: true }); }

function runDaemon(env, cmd) {
  return spawnSync("node", ["src/daemon.js", cmd], {
    env: { ...process.env, HOME: env.home, PATH: process.env.PATH },
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
}

function insertObs(dbPath, title, subtitle) {
  execFileSync("sqlite3", [dbPath, `
    INSERT INTO observations (title, subtitle, created_at_epoch)
    VALUES ('${title.replace(/'/g, "''")}', '${subtitle.replace(/'/g, "''")}', ${Date.now()});
  `]);
}

test("daemon reset initializes cursor to 0", () => {
  const env = mkEnv();
  const r = runDaemon(env, "reset");
  assert.match(r.stdout, /cursor reset to 0/);
  const cursor = JSON.parse(readFileSync(join(env.home, ".claude", "ace.cursor.json"), "utf8"));
  assert.equal(cursor.lastId, 0);
  cleanup(env);
});

test("daemon status reports cursor", () => {
  const env = mkEnv();
  runDaemon(env, "reset");
  const r = runDaemon(env, "status");
  assert.match(r.stdout, /cursor:\s*0/);
  cleanup(env);
});

test("daemon once is no-op on empty DB", () => {
  const env = mkEnv();
  runDaemon(env, "reset");
  const r = runDaemon(env, "once");
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  // Cursor unchanged (no rows)
  const cursor = JSON.parse(readFileSync(join(env.home, ".claude", "ace.cursor.json"), "utf8"));
  assert.equal(cursor.lastId, 0);
  cleanup(env);
});

test("daemon once advances cursor past processed rows", () => {
  const env = mkEnv();
  runDaemon(env, "reset");
  insertObs(env.dbPath, "First", "one");
  insertObs(env.dbPath, "Second", "two");
  insertObs(env.dbPath, "Third", "three");
  const r = runDaemon(env, "once");
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  const cursor = JSON.parse(readFileSync(join(env.home, ".claude", "ace.cursor.json"), "utf8"));
  assert.equal(cursor.lastId, 3, "cursor should advance to highest id seen");
  cleanup(env);
});

test("daemon log file is written with timestamp lines", () => {
  const env = mkEnv();
  runDaemon(env, "reset");
  insertObs(env.dbPath, "Test observation", "subtitle");
  runDaemon(env, "once");
  const logPath = join(env.home, ".claude", "ace.log");
  assert.ok(existsSync(logPath));
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /ingesting \d+ new observations/);
  cleanup(env);
});

test("daemon processes only new rows on second tick", () => {
  const env = mkEnv();
  runDaemon(env, "reset");
  insertObs(env.dbPath, "A", "1");
  runDaemon(env, "once"); // cursor → 1
  insertObs(env.dbPath, "B", "2");
  insertObs(env.dbPath, "C", "3");
  runDaemon(env, "once"); // should process only B and C
  const cursor = JSON.parse(readFileSync(join(env.home, ".claude", "ace.cursor.json"), "utf8"));
  assert.equal(cursor.lastId, 3);
  const log = readFileSync(join(env.home, ".claude", "ace.log"), "utf8");
  // Should have 2 ingestion log entries
  const matches = log.match(/ingesting \d+ new observations/g) || [];
  assert.equal(matches.length, 2);
  cleanup(env);
});
