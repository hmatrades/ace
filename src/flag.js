#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// flag — Subjective salience pointers with decay
//
// Shared persistent store at ~/.claude/flags.json
// Used by: Claude Code, Copilot CLI, OpenClaude, PACT engine
//
// CLI:  flag ping <concept> [half_life]
//       flag recall <concept>
//       flag top [n]
//       flag eff <concept>
//       flag prune
//       flag simulate <concept> [days]
//       flag export
//       flag import < file.json
//       flag clear
//
// API:  import { ping, recall, top, eff, prune, load, save } from '~/.claude/flag.js'
//
// Designed by Ace × Claude
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { recordPingSync, neighbors, cluster, formatNeighbors, formatCluster } from "./graph.js";
import { readNote, listNotes, formatNote, formatNoteList } from "./notes.js";

const FLAGS_PATH = join(homedir(), ".claude", "flags.json");
const DEFAULT_HL = 21;
const PRUNE_THRESH = 0.5;

// ── Day epoch (integer days since Unix epoch) ──
function dayNow() {
  return Math.floor(Date.now() / 86400000);
}

// ── Effective salience: hits * 0.5^(days_idle / half_life) ──
function effective(f) {
  const idle = dayNow() - f.seen;
  if (idle <= 0) return f.hits;
  return f.hits * Math.pow(0.5, idle / f.hl);
}

// ── Stance from effective salience ──
function stance(eff) {
  if (eff >= 8) return "strong";
  if (eff >= 3) return "familiar";
  if (eff >= 1) return "light";
  return "faded";
}

// ── Round to 1 decimal ──
function r1(n) {
  return Math.round(n * 10) / 10;
}

// ── Persistence ──
function load() {
  if (!existsSync(FLAGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(FLAGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(flags) {
  writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2) + "\n");
}

// ── API ──
function ping(concept, halfLife) {
  const flags = load();
  const now = dayNow();
  const c = String(concept);
  if (flags[c]) {
    flags[c].hits++;
    flags[c].seen = now;
  } else {
    flags[c] = { hits: 1, seen: now, hl: halfLife || DEFAULT_HL };
  }
  // A2: update co-occurrence graph in the same flags object, then save once
  recordPingSync(c, flags);
  save(flags);
  return flags[c];
}

function recall(concept) {
  const flags = load();
  const c = String(concept);
  if (!flags[c]) return null;
  const f = flags[c];
  const eff = effective(f);
  return {
    concept: c,
    hits: f.hits,
    eff: r1(eff),
    idle: dayNow() - f.seen,
    hl: f.hl,
    stance: stance(eff),
  };
}

function eff(concept) {
  const flags = load();
  const c = String(concept);
  if (!flags[c]) return 0;
  return r1(effective(flags[c]));
}

function top(n = 10) {
  const flags = load();
  const arr = Object.entries(flags).map(([c, f]) => {
    const e = effective(f);
    return { concept: c, hits: f.hits, eff: r1(e), idle: dayNow() - f.seen, hl: f.hl, stance: stance(e) };
  });
  arr.sort((a, b) => b.eff - a.eff);
  return arr.slice(0, n);
}

function prune() {
  const flags = load();
  const dead = [];
  for (const [c, f] of Object.entries(flags)) {
    if (effective(f) < PRUNE_THRESH) {
      dead.push(c);
      delete flags[c];
    }
  }
  if (dead.length) save(flags);
  return dead;
}

function simulate(concept, days = 60) {
  const flags = load();
  const c = String(concept);
  if (!flags[c]) return null;
  const f = flags[c];
  const curve = [];
  for (let d = 0; d <= days; d += Math.max(1, Math.floor(days / 20))) {
    const e = f.hits * Math.pow(0.5, d / f.hl);
    curve.push({ day: d, eff: r1(e), stance: stance(e) });
  }
  return { concept: c, hits: f.hits, hl: f.hl, curve };
}

function clearAll() {
  save({});
}

function exportAll() {
  return load();
}

function importAll(data) {
  const flags = load();
  let count = 0;
  for (const [c, f] of Object.entries(data)) {
    if (f && typeof f.hits === "number") {
      flags[c] = { hits: f.hits, seen: f.seen || dayNow(), hl: f.hl || DEFAULT_HL };
      count++;
    }
  }
  save(flags);
  return count;
}

// ── Exports for API use ──
export { ping, recall, eff, top, prune, simulate, clearAll, exportAll, importAll, load, save, effective, stance, FLAGS_PATH };

// ── CLI ──
if (process.argv[1]?.endsWith("flag.js") || process.argv[1]?.endsWith("flag")) {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  switch (cmd) {
    case "ping": {
      if (!arg1) { console.error("usage: flag ping <concept> [half_life]"); process.exit(1); }
      const f = ping(arg1, arg2 ? parseInt(arg2) : undefined);
      const e = r1(effective(f));
      console.log(`  ${arg1}  hits=${f.hits}  eff=${e}  stance=${stance(e)}`);
      break;
    }
    case "recall": {
      if (!arg1) { console.error("usage: flag recall <concept>"); process.exit(1); }
      const r = recall(arg1);
      if (!r) { console.log(`  no flag for '${arg1}'`); break; }
      console.log(`  concept:  ${r.concept}`);
      console.log(`  hits:     ${r.hits}`);
      console.log(`  eff:      ${r.eff}  (${r.idle}d idle, hl=${r.hl}d)`);
      console.log(`  stance:   ${r.stance}`);
      break;
    }
    case "top": {
      const n = arg1 ? parseInt(arg1) : 10;
      const list = top(n);
      if (!list.length) { console.log("  (no flags)"); break; }
      const w = Math.max(...list.map((f) => f.concept.length), 7);
      console.log(`  ${"concept".padEnd(w)}  hits    eff  idle  stance`);
      console.log(`  ${"—".repeat(w)}  ——  ——————  ————  ————————`);
      for (const f of list) {
        const idle = f.idle === 0 ? "now" : `${f.idle}d`;
        console.log(`  ${f.concept.padEnd(w)}  ${String(f.hits).padStart(4)}  ${String(f.eff).padStart(6)}  ${idle.padStart(4)}  ${f.stance}`);
      }
      break;
    }
    case "eff": {
      if (!arg1) { console.error("usage: flag eff <concept>"); process.exit(1); }
      console.log(eff(arg1));
      break;
    }
    case "prune": {
      const dead = prune();
      if (dead.length) {
        for (const c of dead) console.log(`  pruned '${c}'`);
        console.log(`  removed ${dead.length}`);
      } else {
        console.log("  nothing to prune");
      }
      break;
    }
    case "simulate": {
      if (!arg1) { console.error("usage: flag simulate <concept> [days]"); process.exit(1); }
      const s = simulate(arg1, arg2 ? parseInt(arg2) : 60);
      if (!s) { console.log(`  no flag for '${arg1}'`); break; }
      console.log(`  ${s.concept}  (hits=${s.hits}, hl=${s.hl}d)\n`);
      for (const pt of s.curve) {
        const bar = "█".repeat(Math.max(0, Math.round(pt.eff * 2)));
        console.log(`  day ${String(pt.day).padStart(3)}: ${String(pt.eff).padStart(6)}  ${bar.padEnd(30)}  ${pt.stance}`);
      }
      break;
    }
    case "export": {
      console.log(JSON.stringify(exportAll(), null, 2));
      break;
    }
    case "import": {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (input += d));
      process.stdin.on("end", () => {
        try {
          const count = importAll(JSON.parse(input));
          console.log(`  imported ${count} flags`);
        } catch (e) {
          console.error("  invalid JSON:", e.message);
          process.exit(1);
        }
      });
      break;
    }
    case "clear": {
      clearAll();
      console.log("  all flags cleared");
      break;
    }
    case "graph": {
      if (!arg1) { console.error("usage: flag graph <concept>"); process.exit(1); }
      console.log(formatNeighbors(arg1, neighbors(arg1, arg2 ? parseInt(arg2) : 10)));
      break;
    }
    case "cluster": {
      if (!arg1) { console.error("usage: flag cluster <concept> [depth]"); process.exit(1); }
      console.log(formatCluster(arg1, cluster(arg1, arg2 ? parseInt(arg2) : 2)));
      break;
    }
    case "note": {
      if (!arg1) { console.error("usage: flag note <slug>"); process.exit(1); }
      console.log(formatNote(readNote(arg1)));
      break;
    }
    case "notes": {
      console.log(formatNoteList(listNotes()));
      break;
    }
    case "ingest": {
      // flag ingest "observation text"
      // Runs extraction + routes concepts to flags, facts to notes.
      if (!arg1) { console.error("usage: flag ingest \"observation text\""); process.exit(1); }
      const text = process.argv.slice(3).join(" ") ? `${arg1} ${process.argv.slice(3).join(" ")}` : arg1;
      const { extractAndIngest } = await import("./router.js");
      const r = await extractAndIngest(text);
      console.log(`  pinged: ${r.pinged.join(", ") || "(none)"}`);
      if (r.notes.length) console.log(`  notes:  ${r.notes.join(", ")}`);
      break;
    }
    default:
      console.log("flag — ACE salience pointers with decay + co-occurrence graph");
      console.log("");
      console.log("commands:");
      console.log("  flag ping <concept> [half_life]   touch a concept (default hl=21d)");
      console.log("  flag recall <concept>             look up salience + stance");
      console.log("  flag top [n]                      top N by effective salience");
      console.log("  flag eff <concept>                effective salience number");
      console.log("  flag graph <concept> [n]          show concept's top co-occurring neighbors");
      console.log("  flag cluster <concept> [depth]    expanded association cluster (BFS)");
      console.log("  flag note <slug>                  view arbitrary-fact note");
      console.log("  flag notes                        list all notes");
      console.log("  flag ingest \"text\"                LLM-extract + route concepts/facts");
      console.log("  flag prune                        remove decayed flags");
      console.log("  flag simulate <concept> [days]    show decay curve");
      console.log("  flag export                       dump all flags as JSON");
      console.log("  flag import < file.json           import flags from JSON");
      console.log("  flag clear                        remove all flags");
      console.log("");
      console.log(`store: ${FLAGS_PATH}`);
  }
}
