#!/usr/bin/env node
// ACE recall benchmark — proves the thesis with numbers.
//
// For a set of user queries, measures:
//   - Claude-mem: how many tokens does the retrieved context cost? Does the
//     right concept appear in the top-K results?
//   - ACE:        how many tokens does the $ACE block + relevant note cost?
//     Does the right concept appear in top-K?
//
// Recall@K = fraction of queries where the expected concept is in top-K results.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadFlags, effective, stance } from "../src/store.js";

const QUESTIONS = join(new URL("..", import.meta.url).pathname, "bench/questions.json");
const CMEM_DB = join(homedir(), ".claude-mem", "claude-mem.db");

// Token estimate (same method as earlier layered compression report)
const estTokens = (s) => Math.ceil((s || "").length / 4);

// ── Claude-mem retrieval via FTS ──
// Uses observations_fts table's MATCH to retrieve top-K relevant rows.
function cmemRetrieve(query, k = 5) {
  // Quote each term to prevent FTS5 from interpreting them as column names/operators.
  // Strip punctuation, drop short stopwords, quote, OR together.
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(the|and|for|with|did|was|are|you|any|what|have|into|from|about|this|that|will|been|work)$/.test(w))
    .slice(0, 6)
    .map((w) => `"${w}"`);
  if (!terms.length) return [];
  const match = terms.join(" OR ");
  const sql = `
    SELECT o.id, o.title, o.subtitle
    FROM observations o
    JOIN observations_fts fts ON fts.rowid = o.id
    WHERE observations_fts MATCH '${match}'
    ORDER BY fts.rank
    LIMIT ${k};
  `;
  try {
    const out = execFileSync("sqlite3", ["-json", CMEM_DB, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return out.trim() ? JSON.parse(out) : [];
  } catch { return []; }
}

// ── ACE retrieval ──
// Strategy: given a query, extract candidate terms and match against flag
// concepts by substring. Return top-K flags by effective salience + match
// quality. This simulates what Claude would "retrieve" from a $ACE block.
function aceRetrieve(query, k = 5) {
  const flags = loadFlags();
  const q = query.toLowerCase();
  const scored = [];
  for (const [concept, f] of Object.entries(flags)) {
    const slugAsWords = concept.replace(/_/g, " ");
    let score = 0;
    if (q.includes(slugAsWords)) score += 10;
    for (const word of slugAsWords.split(" ")) {
      if (word.length >= 3 && q.includes(word)) score += 2;
    }
    if (score > 0) {
      scored.push({ concept, score: score + effective(f), eff: effective(f) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ── Context size: what Claude would load at session start in each system ──
function cmemSessionContext() {
  // claude-mem's session-start dump shown at boot: 50 most recent observations
  const sql = `SELECT title, subtitle FROM observations ORDER BY id DESC LIMIT 50`;
  try {
    const out = execFileSync("sqlite3", ["-json", CMEM_DB, sql], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const rows = out.trim() ? JSON.parse(out) : [];
    const text = rows.map((r) => `- ${r.title || ""}: ${r.subtitle || ""}`).join("\n");
    return { tokens: estTokens(text), text };
  } catch { return { tokens: 0, text: "" }; }
}

function aceSessionContext() {
  // Use the hook output directly
  const hookPath = join(new URL("..", import.meta.url).pathname, "plugin/hooks/ace-hook.js");
  try {
    const out = execFileSync("node", [hookPath, "context"], { encoding: "utf8" });
    const p = JSON.parse(out);
    const text = p.hookSpecificOutput?.additionalContext || "";
    return { tokens: estTokens(text), text };
  } catch { return { tokens: 0, text: "" }; }
}

// ── Main benchmark ──
function loadQuestions() {
  if (!existsSync(QUESTIONS)) {
    console.error(`questions.json not found at ${QUESTIONS}`);
    console.error("Run with --generate to build a question set from flag state");
    process.exit(1);
  }
  return JSON.parse(readFileSync(QUESTIONS, "utf8"));
}

// Generate questions from REAL claude-mem observation titles, so both systems
// see the same source material. This avoids biasing toward ACE's own vocabulary.
function generateQuestions(outPath, n = 20) {
  // Pull 20 random observations that had meaningful concepts extracted
  const sql = `SELECT id, title, subtitle FROM observations WHERE LENGTH(title) > 20 ORDER BY RANDOM() LIMIT ${n}`;
  const rows = JSON.parse(execFileSync("sqlite3", ["-json", CMEM_DB, sql], { encoding: "utf8" }));

  const questions = rows.map((r) => {
    // Question = natural rephrasing of the title (strip leading verbs)
    const title = (r.title || "").replace(/^(Implemented|Configured|Added|Built|Created|Verified|Deployed|Generated|Fixed|Updated)\s+/i, "");
    const query = `did I work on ${title.toLowerCase()}?`;
    // Expected keyword: pick the most content-bearing noun from the title
    const keywords = title.toLowerCase().split(/\s+/)
      .filter((w) => w.length >= 5 && !/^(with|for|into|using|from|about)$/.test(w))
      .slice(0, 3);
    return {
      query,
      expect_id: r.id,
      expect_keywords: keywords,
    };
  });
  writeFileSync(outPath, JSON.stringify(questions, null, 2));
  console.log(`wrote ${questions.length} questions to ${outPath}`);
}

function bench() {
  const questions = loadQuestions();
  let cmemHits = 0;
  let aceHits = 0;
  const details = [];

  for (const q of questions) {
    const { query, expect_id, expect_keywords = [] } = q;
    const cmem = cmemRetrieve(query, 5);
    const ace = aceRetrieve(query, 5);

    // Claude-mem "hit" if the source observation ID appears in top-5 OR
    // any expected keyword appears in any retrieved title/subtitle.
    const cmemHit =
      cmem.some((r) => r.id === expect_id) ||
      cmem.some((r) =>
        expect_keywords.some((kw) =>
          (r.title || "").toLowerCase().includes(kw) ||
          (r.subtitle || "").toLowerCase().includes(kw)
        )
      );

    // ACE "hit" if any expected keyword matches a retrieved flag concept
    // (concepts use snake_case; keywords are plain words)
    const aceHit = ace.some((r) =>
      expect_keywords.some((kw) => r.concept.includes(kw) || kw.includes(r.concept.replace(/_/g, "")))
    );

    if (cmemHit) cmemHits++;
    if (aceHit) aceHits++;
    details.push({
      query: query.slice(0, 60),
      cmemHit,
      aceHit,
      kws: expect_keywords.slice(0, 2).join(","),
      aceTop: ace.slice(0, 2).map((r) => r.concept).join(","),
    });
  }

  const cmemCtx = cmemSessionContext();
  const aceCtx = aceSessionContext();

  console.log("═".repeat(60));
  console.log("ACE vs CLAUDE-MEM — recall benchmark");
  console.log("═".repeat(60));
  console.log("");
  console.log("Session boot context cost:");
  console.log(`  claude-mem:  ${cmemCtx.tokens.toLocaleString().padStart(7)} tokens  (top 50 observations)`);
  console.log(`  ACE:         ${aceCtx.tokens.toLocaleString().padStart(7)} tokens  ($ACE block)`);
  const ratio = cmemCtx.tokens / aceCtx.tokens;
  console.log(`  ratio:       ${ratio.toFixed(1)}× smaller`);
  console.log("");
  console.log(`Recall@5 (n=${questions.length} queries):`);
  console.log(`  claude-mem:  ${cmemHits}/${questions.length} (${Math.round(cmemHits / questions.length * 100)}%)`);
  console.log(`  ACE:         ${aceHits}/${questions.length} (${Math.round(aceHits / questions.length * 100)}%)`);
  console.log("");
  console.log("Per-query (first 10):");
  for (const d of details.slice(0, 10)) {
    const mark = (h) => (h ? "✓" : "✗");
    console.log(`  cmem=${mark(d.cmemHit)}  ace=${mark(d.aceHit)}  kws=${d.kws.padEnd(22)}  ace_top=${d.aceTop}`);
  }
  if (details.length > 10) console.log(`  ... ${details.length - 10} more`);
}

// ── CLI ──
const arg = process.argv[2];
if (arg === "--generate") {
  generateQuestions(QUESTIONS);
} else {
  bench();
}
