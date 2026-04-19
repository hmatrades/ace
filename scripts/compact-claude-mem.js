#!/usr/bin/env node
// Compact claude-mem observations into flag memory format.
// Extracts themes from titles, counts frequency, dates by most recent.

import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DB = join(homedir(), ".claude-mem", "claude-mem.db");

// Pull all observations via execFileSync (args as array, no shell)
const raw = execFileSync(
  "sqlite3",
  [
    "-json",
    DB,
    "SELECT id, title, subtitle, created_at_epoch, discovery_tokens, type FROM observations ORDER BY created_at_epoch ASC",
  ],
  { maxBuffer: 50 * 1024 * 1024 }
).toString();
const obs = JSON.parse(raw);
console.log(`loaded ${obs.length} observations`);

// Token estimate: ~4 chars per token (English average)
const est = (s) => Math.ceil((s || "").length / 4);

// Raw token cost of keeping all observations as prose
const rawTokens = obs.reduce((a, o) => a + est(o.title) + est(o.subtitle), 0);

// ── Theme extraction ──
// Stopwords: grammar + generic verbs/nouns that pollute titles
const STOP = new Set([
  // grammar
  "a","an","the","and","or","but","in","on","at","to","of","for","with","by",
  "from","up","about","into","through","during","before","after","above","below",
  "is","are","was","were","be","been","being","have","has","had","do","does","did",
  "will","would","should","could","may","might","must","can","shall","that","this",
  "these","those","it","its","as","if","then","else","when","where","while","which",
  "what","who","whom","whose","why","how","not","no","nor","so","than","too","very",
  "just","also","only","own","same","such","both","each","few","more","most","other",
  "some","any","all","via","new","here","there",
  // meta action verbs
  "set","use","used","using","add","added","adding","fix","fixed","fixes","make",
  "made","makes","get","got","gets","run","runs","ran","test","tested","testing",
  "tests","find","found","check","checked","try","tried","based","instead","still",
  "able","being","goes","now","one","two","three",
  // generic process nouns (fluff in titles)
  "created","create","creating","system","implementation","implemented","configuration",
  "configured","successfully","comprehensive","identified","structure","execution",
  "integration","setup","complete","completed","completion","established","designed",
  "architecture","framework","process","processed","handling","handle","enabled",
  "supports","provides","feature","features","capability","capabilities","approach",
  "generated","generate","generating","building","built","ship","shipped","verify",
  "verified","validated","validates","validation","ensure","ensures","ensured",
  "across","within","per","between","against","during","upon","where","while",
]);

function extractKeywords(text) {
  if (!text) return [];
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s\-_]/g, " ");
  return cleaned.split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

function ngrams(words, n) {
  const out = [];
  for (let i = 0; i <= words.length - n; i++) out.push(words.slice(i, i + n).join("_"));
  return out;
}

const themeCounts = new Map();
const themeLastSeen = new Map();
const themeFirstSeen = new Map();

for (const o of obs) {
  const text = `${o.title || ""} ${o.subtitle || ""}`;
  const kw = extractKeywords(text);
  const themes = new Set([...kw, ...ngrams(kw, 2)]);
  const day = Math.floor(o.created_at_epoch / 86400000); // ms → days
  for (const t of themes) {
    themeCounts.set(t, (themeCounts.get(t) || 0) + 1);
    themeLastSeen.set(t, Math.max(themeLastSeen.get(t) || 0, day));
    const first = themeFirstSeen.get(t);
    themeFirstSeen.set(t, first === undefined ? day : Math.min(first, day));
  }
}

// Filter: keep themes with count >= 3 and length >= 4
const MIN_COUNT = 3;
const themes = [...themeCounts.entries()]
  .filter(([t, n]) => n >= MIN_COUNT && t.length >= 4)
  .sort((a, b) => b[1] - a[1]);

// Drop unigrams subsumed by similar-count bigrams
const filtered = [];
for (const [t, n] of themes) {
  if (!t.includes("_")) {
    let subsumed = false;
    for (const [bt, bn] of themes) {
      if (bt.includes("_") && bt.split("_").includes(t) && bn >= n * 0.8) {
        subsumed = true;
        break;
      }
    }
    if (subsumed) continue;
  }
  filtered.push([t, n]);
}

// Half-life from date spread + hit count
// Sustained concepts across whole window get deep HL; short bursts get short HL
function halfLife(first, last, hits) {
  const spread = last - first;
  // Sustained across full ~9d window with many hits → deep
  if (spread >= 7 && hits >= 15) return 60;
  if (spread >= 7 && hits >= 5) return 30;
  if (spread >= 3) return 21;
  return 14;
}

const flags = {};
for (const [t, n] of filtered.slice(0, 100)) {
  flags[t] = {
    hits: n,
    seen: themeLastSeen.get(t),
    hl: halfLife(themeFirstSeen.get(t), themeLastSeen.get(t), n),
  };
}

// Token cost of flag representation
const flagChars = Object.entries(flags).reduce(
  (a, [k, v]) => a + k.length + JSON.stringify(v).length + 6,
  0
);
const flagTokens = Math.ceil(flagChars / 4);

// ── Report ──
console.log("\n" + "═".repeat(60));
console.log("CLAUDE-MEM COMPACTION via FLAG MEMORY");
console.log("═".repeat(60));
console.log(`source:        ${obs.length} observations`);
console.log(`raw cost:      ~${rawTokens.toLocaleString()} tokens (titles+subtitles only)`);
console.log(`themes found:  ${themeCounts.size} candidates, ${filtered.length} above min_count=${MIN_COUNT}`);
console.log(`flag entries:  ${Object.keys(flags).length} (top 100)`);
console.log(`flag cost:     ~${flagTokens.toLocaleString()} tokens`);
console.log(`compression:   ${(rawTokens / flagTokens).toFixed(1)}× (${Math.round((1 - flagTokens / rawTokens) * 100)}% reduction)`);
console.log("");

console.log("top 25 concepts by hit count:");
console.log("-".repeat(60));
const top25 = filtered.slice(0, 25);
const w = Math.max(...top25.map(([t]) => t.length));
console.log(`${"concept".padEnd(w)}  hits  spread   hl`);
for (const [t, n] of top25) {
  const first = themeFirstSeen.get(t);
  const last = themeLastSeen.get(t);
  const spread = last - first;
  const hl = halfLife(first, last, n);
  console.log(`${t.padEnd(w)}  ${String(n).padStart(4)}  ${String(spread).padStart(4)}d  ${String(hl).padStart(3)}d`);
}

const outFile = "/tmp/claude-mem-compacted.json";
writeFileSync(outFile, JSON.stringify(flags, null, 2));
console.log(`\ncompacted flags written to: ${outFile}`);
console.log(`import with: flag import < ${outFile}`);
