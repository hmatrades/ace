// ACE shared persistence layer
// Single source of truth for the flag store file and config lookup.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const FLAGS_PATH = join(CLAUDE_DIR, "flags.json");
export const NOTES_DIR = join(CLAUDE_DIR, "notes");
export const CONFIG_PATH = join(CLAUDE_DIR, "ace.config.json");

export const DEFAULT_HL = 21;
export const PRUNE_THRESH = 0.5;

// ── Day epoch ──
export function dayNow() {
  return Math.floor(Date.now() / 86400000);
}

// ── Decay math ──
export function effective(f) {
  const idle = dayNow() - f.seen;
  if (idle <= 0) return f.hits;
  return f.hits * Math.pow(0.5, idle / f.hl);
}

export function stance(eff) {
  if (eff >= 8) return "strong";
  if (eff >= 3) return "familiar";
  if (eff >= 1) return "light";
  return "faded";
}

export function r1(n) { return Math.round(n * 10) / 10; }

// ── Flag store I/O ──
export function loadFlags() {
  if (!existsSync(FLAGS_PATH)) return {};
  try { return JSON.parse(readFileSync(FLAGS_PATH, "utf8")); }
  catch { return {}; }
}

export function saveFlags(flags) {
  mkdirSync(dirname(FLAGS_PATH), { recursive: true });
  writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2) + "\n");
}

// ── Config ──
// Looked up at runtime; supports env var override for extraction backend
export function loadConfig() {
  const defaults = {
    extract: {
      backend: "haiku",         // haiku | claude-cli | ollama
      haikuModel: "claude-haiku-4-5-20251001",
      ollamaModel: "llama3.2:3b",
      batchSize: 20,
      fallbackChain: ["haiku", "claude-cli", "ollama"],
    },
    daemon: {
      pollSeconds: 60,
      claudemem_db: join(homedir(), ".claude-mem", "claude-mem.db"),
    },
    graph: {
      windowMinutes: 5,         // concepts pinged within this window co-occur
      minCoocWeight: 2,         // ignore co-occurrences weaker than this in display
    },
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      extract: { ...defaults.extract, ...(user.extract || {}) },
      daemon: { ...defaults.daemon, ...(user.daemon || {}) },
      graph: { ...defaults.graph, ...(user.graph || {}) },
    };
  } catch { return defaults; }
}

export function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
