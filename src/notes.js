// ACE notes — arbitrary-fact storage
//
// Flags can't capture "Stripe rotates every 90 days" because that fact is
// not reconstructable from model weights. Notes store these specifics.
//
// Layout:
//   ~/.claude/notes/{slug}.md   ← one note per topic slug
//
// Each note has frontmatter:
//   ---
//   linked_flag: stripe_api_keys
//   updated: 2026-04-16
//   ---
//   - rotates every 90 days
//   - last rotated 2026-03-01
//
// Notes are plain Markdown so they're editable, greppable, git-diffable.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { NOTES_DIR } from "./store.js";

// Sanitize a concept name or free text into a filesystem slug
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "note";
}

function notePath(slug) {
  return join(NOTES_DIR, `${slug}.md`);
}

// ── Read ──
export function readNote(slug) {
  const p = notePath(slug);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return parseNote(raw, slug);
}

function parseNote(raw, slug) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { slug, meta: {}, body: raw.trim(), facts: [raw.trim()].filter(Boolean) };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const body = m[2].trim();
  const facts = body
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  return { slug, meta, body, facts };
}

function serializeNote(note) {
  const meta = note.meta || {};
  meta.updated = new Date().toISOString().slice(0, 10);
  const frontmatter = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const body = note.facts && note.facts.length
    ? note.facts.map((f) => `- ${f}`).join("\n")
    : (note.body || "").trim();
  return `---\n${frontmatter}\n---\n${body}\n`;
}

// ── Write / merge ──
export function writeNote(slug, update) {
  mkdirSync(NOTES_DIR, { recursive: true });
  const existing = readNote(slug);
  const merged = {
    slug,
    meta: { ...(existing?.meta || {}), ...(update.meta || {}) },
    facts: existing ? dedupeFacts([...existing.facts, ...(update.facts || [])]) : (update.facts || []),
  };
  writeFileSync(notePath(slug), serializeNote(merged));
  return merged;
}

function dedupeFacts(facts) {
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const key = f.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function addFact(slug, fact, linkedFlag = null) {
  const meta = linkedFlag ? { linked_flag: linkedFlag } : {};
  return writeNote(slug, { meta, facts: [fact] });
}

export function deleteNote(slug) {
  const p = notePath(slug);
  if (existsSync(p)) { unlinkSync(p); return true; }
  return false;
}

// ── List ──
export function listNotes() {
  if (!existsSync(NOTES_DIR)) return [];
  return readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = basename(f, ".md");
      const note = readNote(slug);
      return {
        slug,
        linked_flag: note?.meta?.linked_flag || null,
        updated: note?.meta?.updated || null,
        factCount: note?.facts?.length || 0,
      };
    })
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

// ── CLI format helpers ──
export function formatNote(note) {
  if (!note) return "  (no note)";
  const lines = [`  ${note.slug}:`];
  if (note.meta?.linked_flag) lines.push(`  linked flag: ${note.meta.linked_flag}`);
  if (note.meta?.updated) lines.push(`  updated: ${note.meta.updated}`);
  lines.push("");
  for (const f of note.facts) lines.push(`  - ${f}`);
  return lines.join("\n");
}

export function formatNoteList(list) {
  if (!list.length) return "  (no notes)";
  const w = Math.max(...list.map((n) => n.slug.length), 4);
  const lines = [];
  lines.push(`  ${"slug".padEnd(w)}  linked_flag          updated      facts`);
  lines.push(`  ${"—".repeat(w)}  ——————————————————  ——————————  —————`);
  for (const n of list) {
    const link = (n.linked_flag || "-").padEnd(18);
    const up = (n.updated || "-").padEnd(10);
    lines.push(`  ${n.slug.padEnd(w)}  ${link}  ${up}  ${n.factCount}`);
  }
  return lines.join("\n");
}
