#!/usr/bin/env node
// ACE daemon — continuous ingestion of claude-mem observations
//
// Watches ~/.claude-mem/claude-mem.db every poll interval (default 60s).
// New observations since last cursor get:
//   1. title+subtitle sent through extract.js (LLM pass)
//   2. concepts → flag pings via router.ingest
//   3. facts    → notes
//   4. cooc     → graph edges
//
// Cursor persisted at ~/.claude/ace.cursor.json (max id seen).
// Log to ~/.claude/ace.log, rotated at 10MB.
//
// Run foreground: `node src/daemon.js`
// Install as launchd: `scripts/setup-daemon.sh`

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { loadConfig, CLAUDE_DIR } from "./store.js";
import { extractBatch } from "./extract.js";
import { ingest } from "./router.js";

const CURSOR_PATH = join(CLAUDE_DIR, "ace.cursor.json");
const LOG_PATH = join(CLAUDE_DIR, "ace.log");
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

function loadCursor() {
  if (!existsSync(CURSOR_PATH)) return { lastId: 0 };
  try { return JSON.parse(readFileSync(CURSOR_PATH, "utf8")); }
  catch { return { lastId: 0 }; }
}
function saveCursor(cursor) {
  mkdirSync(dirname(CURSOR_PATH), { recursive: true });
  writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
}

function log(msg) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  // Rotate if too big
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_ROTATE_BYTES) {
      renameSync(LOG_PATH, LOG_PATH + ".old");
    }
  } catch {}
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { writeFileSync(LOG_PATH, line, { flag: "a" }); } catch {}
  // Also to stderr when running foreground
  if (process.stderr.isTTY) process.stderr.write(line);
}

// Fetch new observations since lastId
function fetchNewObservations(dbPath, lastId, limit = 100) {
  const sql = `SELECT id, title, subtitle FROM observations WHERE id > ${lastId} ORDER BY id ASC LIMIT ${limit}`;
  try {
    const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return out.trim() ? JSON.parse(out) : [];
  } catch (e) {
    log(`fetch error: ${e.message}`);
    return [];
  }
}

// Run one poll cycle
async function tick() {
  const cfg = loadConfig();
  const dbPath = cfg.daemon.claudemem_db;
  if (!existsSync(dbPath)) { log(`claude-mem db not found: ${dbPath}`); return; }

  const cursor = loadCursor();
  const rows = fetchNewObservations(dbPath, cursor.lastId, 100);
  if (!rows.length) return; // nothing new

  log(`ingesting ${rows.length} new observations (from id ${cursor.lastId + 1})`);

  const texts = rows.map((r) => `${r.title || ""} — ${r.subtitle || ""}`.trim());
  let extractions;
  try {
    extractions = await extractBatch(texts, cfg);
  } catch (e) {
    log(`batch extraction failed: ${e.message}`);
    return;
  }

  let maxId = cursor.lastId;
  let totalPinged = 0;
  let totalNotes = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ex = extractions[i] || { concepts: [], facts: [] };
    if (ex.concepts.length || ex.facts.length) {
      const r = ingest(ex, { source: texts[i] });
      totalPinged += r.pinged.length;
      totalNotes += r.notes.length;
    }
    if (row.id > maxId) maxId = row.id;
  }
  saveCursor({ lastId: maxId, at: new Date().toISOString() });
  log(`done: ${totalPinged} concepts pinged, ${totalNotes} notes updated, cursor → ${maxId}`);
}

// ── Main loop ──
async function main() {
  const cfg = loadConfig();
  const interval = (cfg.daemon.pollSeconds || 60) * 1000;
  log(`ACE daemon starting — poll every ${cfg.daemon.pollSeconds}s`);
  log(`watching: ${cfg.daemon.claudemem_db}`);

  // Run one tick immediately, then on interval
  await tick().catch((e) => log(`tick error: ${e.message}`));
  setInterval(async () => {
    try { await tick(); }
    catch (e) { log(`tick error: ${e.message}`); }
  }, interval);
}

// ── CLI entrypoints ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "once") {
    await tick();
    process.exit(0);
  } else if (cmd === "status") {
    const cursor = loadCursor();
    console.log(`cursor: ${cursor.lastId} (last tick: ${cursor.at || "never"})`);
    if (existsSync(LOG_PATH)) {
      const tail = readFileSync(LOG_PATH, "utf8").split("\n").slice(-10).join("\n");
      console.log("\n=== last log lines ===");
      console.log(tail);
    }
    process.exit(0);
  } else if (cmd === "reset") {
    saveCursor({ lastId: 0 });
    console.log("cursor reset to 0 — next tick will ingest from scratch");
    process.exit(0);
  } else {
    // Default: run main loop
    main();
  }
}

export { tick, loadCursor, saveCursor };
