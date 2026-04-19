// ACE co-occurrence graph
//
// Tracks which concepts are pinged in the same time window.
// Over sessions, an emergent association graph builds up:
//   ping("outreach") near ping("gmail_api") near ping("klaff")
//   → cooc["outreach"]["gmail_api"] += 1
//   → cooc["outreach"]["klaff"] += 1
//
// This is structure that content-based memory systems fundamentally cannot produce.
// They can retrieve similar text. They cannot answer "what do I usually work on
// alongside outreach?" without re-scanning the whole corpus.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { loadFlags, saveFlags, loadConfig, effective, stance } from "./store.js";

// Recent-ping log: a tiny rolling buffer of {concept, ts_ms} entries.
// Lives beside flags.json so daemon + CLI + hooks all update the same stream.
const RECENT_PATH = join(homedir(), ".claude", "flags.recent.json");

function loadRecent() {
  if (!existsSync(RECENT_PATH)) return [];
  try { return JSON.parse(readFileSync(RECENT_PATH, "utf8")); }
  catch { return []; }
}

function saveRecent(entries) {
  mkdirSync(dirname(RECENT_PATH), { recursive: true });
  writeFileSync(RECENT_PATH, JSON.stringify(entries) + "\n");
}

/**
 * Record that a concept was just pinged, and update co-occurrence weights
 * against every other concept pinged within the window.
 *
 * Pure sync: mutates flags in place, does not save. Caller saves.
 * Updates rolling buffer at ~/.claude/flags.recent.json.
 */
export function recordPingSync(concept, flags) {
  const cfg = loadConfig();
  const now = Date.now();
  const windowMs = (cfg.graph.windowMinutes || 5) * 60 * 1000;

  // 1. Prune expired entries from rolling buffer
  const recent = loadRecent().filter((e) => now - e.ts < windowMs);

  // 2. Find co-occurrences: every recent concept that isn't `concept` itself
  const coocPartners = new Set();
  for (const e of recent) if (e.concept !== concept) coocPartners.add(e.concept);

  // 3. Update cooc weights (bidirectional) — mutation only
  if (!flags[concept]) return { concept, coocPartners: [] };
  flags[concept].cooc = flags[concept].cooc || {};
  for (const partner of coocPartners) {
    flags[concept].cooc[partner] = (flags[concept].cooc[partner] || 0) + 1;
    if (flags[partner]) {
      flags[partner].cooc = flags[partner].cooc || {};
      flags[partner].cooc[concept] = (flags[partner].cooc[concept] || 0) + 1;
    }
  }

  // 4. Append current concept to recent buffer, persist rolling log
  recent.push({ concept, ts: now });
  saveRecent(recent);

  return { concept, coocPartners: [...coocPartners] };
}

/**
 * Return concept's direct neighbors (concepts it frequently co-occurs with).
 * Sorted by cooc weight desc.
 */
export function neighbors(concept, limit = 10) {
  const cfg = loadConfig();
  const flags = loadFlags();
  const f = flags[concept];
  if (!f || !f.cooc) return [];
  const minW = cfg.graph.minCoocWeight || 2;
  const arr = Object.entries(f.cooc)
    .filter(([_, w]) => w >= minW)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return arr.map(([c, weight]) => {
    const partner = flags[c];
    if (!partner) return { concept: c, weight, eff: 0, stance: "faded" };
    const eff = effective(partner);
    return { concept: c, weight, eff: Math.round(eff * 10) / 10, stance: stance(eff) };
  });
}

/**
 * BFS-expand a concept to its connected cluster — every concept transitively
 * reachable via co-occurrence edges above min weight.
 *
 * Useful for "what's the full context around `outreach`?"
 */
export function cluster(concept, depth = 2, minWeight = null) {
  const cfg = loadConfig();
  const flags = loadFlags();
  if (!flags[concept]) return [];
  const w = minWeight ?? cfg.graph.minCoocWeight ?? 2;

  const visited = new Map(); // concept -> depth reached
  const queue = [[concept, 0]];
  while (queue.length) {
    const [c, d] = queue.shift();
    if (visited.has(c)) continue;
    visited.set(c, d);
    if (d >= depth) continue;
    const f = flags[c];
    if (!f || !f.cooc) continue;
    for (const [partner, weight] of Object.entries(f.cooc)) {
      if (weight >= w && !visited.has(partner)) queue.push([partner, d + 1]);
    }
  }
  visited.delete(concept); // remove self
  return [...visited.entries()]
    .map(([c, d]) => {
      const f = flags[c];
      const eff = f ? effective(f) : 0;
      return { concept: c, depth: d, eff: Math.round(eff * 10) / 10, stance: stance(eff) };
    })
    .sort((a, b) => a.depth - b.depth || b.eff - a.eff);
}

/**
 * Print a concept's immediate neighbors as a CLI table.
 */
export function formatNeighbors(concept, list) {
  if (!list.length) return `  no neighbors for '${concept}' yet`;
  const w = Math.max(...list.map((n) => n.concept.length), 7);
  const lines = [];
  lines.push(`  neighbors of '${concept}':`);
  lines.push(`  ${"concept".padEnd(w)}  weight    eff  stance`);
  lines.push(`  ${"—".repeat(w)}  ——————  —————  ————————`);
  for (const n of list) {
    lines.push(`  ${n.concept.padEnd(w)}  ${String(n.weight).padStart(6)}  ${String(n.eff).padStart(5)}  ${n.stance}`);
  }
  return lines.join("\n");
}

export function formatCluster(concept, list) {
  if (!list.length) return `  no cluster around '${concept}'`;
  const w = Math.max(...list.map((n) => n.concept.length), 7);
  const lines = [];
  lines.push(`  cluster around '${concept}':`);
  lines.push(`  ${"concept".padEnd(w)}  depth    eff  stance`);
  lines.push(`  ${"—".repeat(w)}  —————  —————  ————————`);
  for (const n of list) {
    lines.push(`  ${n.concept.padEnd(w)}  ${String(n.depth).padStart(5)}  ${String(n.eff).padStart(5)}  ${n.stance}`);
  }
  return lines.join("\n");
}
