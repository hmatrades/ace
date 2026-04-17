#!/usr/bin/env node
// ACE Claude Code plugin hook
//
// Emits JSON matching Claude Code's hook protocol:
//   { hookSpecificOutput: { hookEventName, additionalContext } }
//
// SessionStart (context): injects a $ACE block showing top flags + clusters
//   for the model to see at session boot. Replaces / supplements $CMEM.
//
// UserPromptSubmit: light ping pass — detects concept keywords in the user's
//   message and increments their flags. Over time builds attention graph.
//
// Designed to be fast (<300ms typical, 15s hard timeout via hooks.json).

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FLAGS_PATH = join(homedir(), ".claude", "flags.json");
const RECENT_PATH = join(homedir(), ".claude", "flags.recent.json");

const mode = process.argv[2] || "context";

function loadFlags() {
  if (!existsSync(FLAGS_PATH)) return {};
  try { return JSON.parse(readFileSync(FLAGS_PATH, "utf8")); }
  catch { return {}; }
}
function dayNow() { return Math.floor(Date.now() / 86400000); }
function effective(f) {
  const idle = dayNow() - f.seen;
  if (idle <= 0) return f.hits;
  return f.hits * Math.pow(0.5, idle / f.hl);
}
function stanceOf(eff) {
  if (eff >= 8) return "strong";
  if (eff >= 3) return "familiar";
  if (eff >= 1) return "light";
  return "faded";
}

// In-process ping batch for user-prompt mode. Replaces N spawnSync("flag",
// "ping", c) calls (~50ms each) with a single pass: N hits bumps, N cooc
// updates through recordPingSync, one flags.json write at the end.
//
// Self-sufficient via store.js imports — doesn't reach into the hook's
// local helpers, so it survives the ACEv2 render-compaction rebase that
// drops those locals in favor of the store.js exports.
async function batchPing(concepts) {
  if (!concepts.length) return;
  const store = await import("../../src/store.js");
  const { recordPingSync } = await import("../../src/graph.js");
  const flags = store.loadFlags();
  const now = store.dayNow();
  for (const c of concepts) {
    if (flags[c]) {
      flags[c].hits++;
      flags[c].seen = now;
    } else {
      flags[c] = { hits: 1, seen: now, hl: 21 };
    }
    recordPingSync(c, flags);
  }
  store.saveFlags(flags);
}

// ── Render the $ACE block ──
function renderContext(flags, opts = {}) {
  const { topN = 12, clustersN = 3 } = opts;
  const entries = Object.entries(flags)
    .map(([c, f]) => ({ c, f, eff: effective(f) }))
    .sort((a, b) => b.eff - a.eff);

  if (!entries.length) return "# $ACE — no flags yet\n";

  const date = new Date().toISOString().slice(0, 10);
  const total = entries.length;
  const strong = entries.filter((e) => e.eff >= 8).length;
  const familiar = entries.filter((e) => e.eff >= 3 && e.eff < 8).length;

  const lines = [];
  lines.push(`# $ACE ${date} — subjective salience map`);
  lines.push(`# ${total} flags tracked · ${strong} strong · ${familiar} familiar`);
  lines.push("");
  lines.push("## Top concepts (by effective salience)");

  for (const e of entries.slice(0, topN)) {
    const s = stanceOf(e.eff);
    const marker = s === "strong" ? "●" : s === "familiar" ? "◐" : "○";
    lines.push(`${marker} ${e.c}  eff=${e.eff.toFixed(1)}  ${s}`);
  }

  // Top clusters: take top-K strong concepts and list their neighbors
  lines.push("");
  lines.push("## Association clusters");
  const clusters = entries
    .filter((e) => e.f.cooc && Object.keys(e.f.cooc).length > 0)
    .slice(0, clustersN);
  if (!clusters.length) {
    lines.push("  (no associations yet — need multi-concept sessions)");
  } else {
    for (const e of clusters) {
      const neighbors = Object.entries(e.f.cooc || {})
        .filter(([_, w]) => w >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([c, w]) => `${c}(${w})`);
      if (neighbors.length) lines.push(`  ${e.c} → ${neighbors.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("## Engagement posture");
  lines.push("  ● strong     — deep history, probe specifics before assuming");
  lines.push("  ◐ familiar   — shared context, ask for refresh on details");
  lines.push("  ○ light      — seen before, don't overclaim memory");
  lines.push("");
  lines.push(`  Full flags: \`cat ${FLAGS_PATH}\``);
  lines.push(`  Inspect:    \`flag recall <concept>\``);
  lines.push(`  Graph:      \`flag graph <concept>\``);

  return lines.join("\n");
}

// ── Mode: context (SessionStart) ──
function emitContext() {
  const flags = loadFlags();
  const body = renderContext(flags);
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: body,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

// ── Mode: user-prompt ──
// Read the user's submitted prompt from stdin, detect any existing flag
// concept mentions, and ping them. No extraction — just cheap keyword match
// against the existing flag vocabulary (fast, no LLM needed here).
function emitUserPrompt() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", async () => {
    let payload = {};
    try { payload = JSON.parse(input); } catch {}
    const userText = payload.prompt || payload.userPrompt || input;
    const text = String(userText).toLowerCase();

    const flags = loadFlags();
    const toBump = [];
    for (const c of Object.keys(flags)) {
      // Match concept as whole word or with word-boundary (outreach, not outreaches)
      const slug = c.replace(/_/g, "[_ -]?");
      if (new RegExp(`\\b${slug}\\b`, "i").test(text)) toBump.push(c);
    }

    // In-process batch: one flags.json write for the whole prompt instead
    // of N subprocess spawns. Fire-and-forget — swallow errors since the
    // hook is side-effect-only and must not block the user's prompt.
    try { await batchPing(toBump); } catch {}

    // Emit empty context — the point is the ping side effect
    process.stdout.write(JSON.stringify({ continue: true }));
  });
}

switch (mode) {
  case "context":      emitContext(); break;
  case "user-prompt":  emitUserPrompt(); break;
  default:
    console.error(`unknown hook mode: ${mode}`);
    process.exit(1);
}
