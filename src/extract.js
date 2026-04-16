// ACE concept extraction — pluggable LLM backends
//
// Takes observation text, returns {concepts: string[], facts: string[]}.
//   concepts: reconstructable semantic themes → route to flags
//   facts:    arbitrary specifics (dates, IDs, numbers, names) → route to notes
//
// Backends (configurable via ~/.claude/ace.config.json):
//   - haiku:      @anthropic-ai/sdk direct (default, fastest, ~$0.04/830 obs)
//   - claude-cli: `claude -p` (uses existing Claude Code auth)
//   - ollama:     local llama3.2:3b (free, offline)
//
// All backends return the same schema. Fallback chain retries on error.

import { spawnSync, execFileSync } from "child_process";
import { loadConfig } from "./store.js";

const SYSTEM_PROMPT = `You extract semantic structure from short observations.

For each observation, return a JSON object:
{
  "concepts": ["snake_case_theme", ...],
  "facts":    ["arbitrary specifics that can't be reconstructed from general knowledge", ...]
}

RULES for concepts:
- Snake_case, 1-3 words max
- Must be a reconstructable theme (e.g., "gmail_api", "outreach", "cold_email", "firewall_rules")
- NOT generic verbs like "created", "implemented", "fixed"
- NOT generic nouns like "file", "system", "project"
- 1-4 concepts per observation; fewer is better
- Prefer domain terms over meta-process words

RULES for facts:
- Only include arbitrary specifics that wouldn't be recoverable from the concept alone
- Examples: "rotates every 90 days", "port 5060 for SIP", "IP 10.0.0.1"
- Most observations have 0 facts; only extract when genuinely arbitrary
- Return as readable English phrases

Return valid JSON only. No prose before or after.`;

const USER_TEMPLATE = (text) => `Observation: ${text}\n\nJSON:`;

// ── Batch prompt for multiple observations at once ──
const BATCH_SYSTEM = `${SYSTEM_PROMPT}

For a batch of observations, return a JSON array of objects in the same order.`;

const BATCH_USER = (texts) =>
  `Observations:\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nJSON array:`;

// ── Backend: Haiku via SDK ──
async function extractHaiku(text, cfg) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const r = await client.messages.create({
    model: cfg.extract.haikuModel,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_TEMPLATE(text) }],
  });
  const out = r.content.find((c) => c.type === "text")?.text || "{}";
  return parseJSON(out);
}

async function extractHaikuBatch(texts, cfg) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const r = await client.messages.create({
    model: cfg.extract.haikuModel,
    max_tokens: 2000,
    system: BATCH_SYSTEM,
    messages: [{ role: "user", content: BATCH_USER(texts) }],
  });
  const out = r.content.find((c) => c.type === "text")?.text || "[]";
  const arr = parseJSON(out);
  return Array.isArray(arr) ? arr.map(normalize) : texts.map(() => empty());
}

// ── Backend: claude -p CLI ──
async function extractClaudeCLI(text, cfg) {
  const prompt = `${SYSTEM_PROMPT}\n\n${USER_TEMPLATE(text)}`;
  const r = spawnSync("claude", ["-p", prompt], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude CLI failed: ${r.stderr}`);
  return parseJSON(r.stdout);
}

async function extractClaudeCLIBatch(texts, cfg) {
  const prompt = `${BATCH_SYSTEM}\n\n${BATCH_USER(texts)}`;
  const r = spawnSync("claude", ["-p", prompt], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`claude CLI failed: ${r.stderr}`);
  const arr = parseJSON(r.stdout);
  return Array.isArray(arr) ? arr.map(normalize) : texts.map(() => empty());
}

// ── Backend: Ollama ──
async function extractOllama(text, cfg) {
  const prompt = `${SYSTEM_PROMPT}\n\n${USER_TEMPLATE(text)}`;
  const r = spawnSync("ollama", ["run", cfg.extract.ollamaModel, prompt], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ollama failed: ${r.stderr}`);
  return parseJSON(r.stdout);
}

async function extractOllamaBatch(texts, cfg) {
  // Ollama has no native batching; sequential is acceptable for offline use
  const results = [];
  for (const t of texts) {
    try { results.push(normalize(await extractOllama(t, cfg))); }
    catch { results.push(empty()); }
  }
  return results;
}

// ── Helpers ──
function parseJSON(raw) {
  // Try direct parse, fall back to extracting first {...} or [...] block
  try { return JSON.parse(raw); } catch {}
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  return {};
}

function normalize(obj) {
  return {
    concepts: Array.isArray(obj?.concepts)
      ? obj.concepts.filter((c) => typeof c === "string" && c.length >= 2).slice(0, 8)
      : [],
    facts: Array.isArray(obj?.facts)
      ? obj.facts.filter((f) => typeof f === "string" && f.length >= 3).slice(0, 4)
      : [],
  };
}

function empty() { return { concepts: [], facts: [] }; }

// ── Public API ──

const BACKENDS = {
  haiku:        { single: extractHaiku,     batch: extractHaikuBatch },
  "claude-cli": { single: extractClaudeCLI, batch: extractClaudeCLIBatch },
  ollama:       { single: extractOllama,    batch: extractOllamaBatch },
};

/**
 * Extract concepts + facts from a single observation text.
 * Uses configured backend with automatic fallback chain on error.
 */
export async function extract(text, cfg = loadConfig()) {
  const chain = [cfg.extract.backend, ...cfg.extract.fallbackChain.filter((b) => b !== cfg.extract.backend)];
  let lastErr;
  for (const backend of chain) {
    const impl = BACKENDS[backend];
    if (!impl) continue;
    try { return normalize(await impl.single(text, cfg)); }
    catch (e) { lastErr = e; }
  }
  if (lastErr) console.error("all backends failed:", lastErr.message);
  return empty();
}

/**
 * Batch extract. Splits into config.extract.batchSize chunks.
 * Returns array of {concepts, facts} aligned with input order.
 */
export async function extractBatch(texts, cfg = loadConfig()) {
  const size = cfg.extract.batchSize || 20;
  const chain = [cfg.extract.backend, ...cfg.extract.fallbackChain.filter((b) => b !== cfg.extract.backend)];
  const out = [];
  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size);
    let chunkResult;
    for (const backend of chain) {
      const impl = BACKENDS[backend];
      if (!impl) continue;
      try { chunkResult = await impl.batch(chunk, cfg); break; }
      catch (e) { /* try next backend */ }
    }
    if (!chunkResult) chunkResult = chunk.map(() => empty());
    out.push(...chunkResult);
  }
  return out;
}

// ── CLI entry: `node src/extract.js "observation text"` ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv.slice(2).join(" ");
  if (!text) {
    console.error("usage: node src/extract.js \"observation text\"");
    console.error("       node src/extract.js --batch < list.txt");
    process.exit(1);
  }
  if (text === "--batch") {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", async () => {
      const texts = input.split("\n").map((l) => l.trim()).filter(Boolean);
      const results = await extractBatch(texts);
      for (let i = 0; i < texts.length; i++) {
        console.log(JSON.stringify({ text: texts[i], ...results[i] }));
      }
    });
  } else {
    const r = await extract(text);
    console.log(JSON.stringify(r, null, 2));
  }
}
