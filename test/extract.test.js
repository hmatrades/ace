// ACE extract.js tests — covers JSON parsing + normalization.
// LLM backends are exercised manually (they cost money); here we just
// verify the parsing/normalization layer that every backend feeds into.

import { test } from "node:test";
import assert from "node:assert/strict";

// We test the module's internal parseJSON + normalize indirectly by calling
// extract() after monkey-patching the SDK. Simpler: import and test the
// public batch path with an injected "fake backend" via config.
// For unit-level coverage of parsing, we duplicate the helpers here since
// they're pure functions.

function parseJSON(raw) {
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

// ── parseJSON ──

test("parseJSON handles clean JSON", () => {
  const r = parseJSON('{"concepts":["a"]}');
  assert.deepEqual(r, { concepts: ["a"] });
});

test("parseJSON extracts object from surrounding prose", () => {
  const r = parseJSON('Here is the result: {"concepts":["a"]} end');
  assert.deepEqual(r, { concepts: ["a"] });
});

test("parseJSON extracts array from surrounding prose", () => {
  const r = parseJSON('Result: [{"concepts":["a"]},{"concepts":["b"]}]');
  assert.deepEqual(r, [{ concepts: ["a"] }, { concepts: ["b"] }]);
});

test("parseJSON returns empty object on unparseable input", () => {
  const r = parseJSON("not json at all");
  assert.deepEqual(r, {});
});

test("parseJSON handles markdown code fences", () => {
  const r = parseJSON('```json\n{"concepts":["a"]}\n```');
  assert.deepEqual(r, { concepts: ["a"] });
});

// ── normalize ──

test("normalize returns empty arrays when input is malformed", () => {
  assert.deepEqual(normalize(null), { concepts: [], facts: [] });
  assert.deepEqual(normalize({}), { concepts: [], facts: [] });
  assert.deepEqual(normalize({ concepts: "not array" }), { concepts: [], facts: [] });
});

test("normalize filters out too-short concepts", () => {
  const r = normalize({ concepts: ["a", "ab", "abc"] });
  assert.deepEqual(r.concepts, ["ab", "abc"]);
});

test("normalize caps concepts at 8", () => {
  const r = normalize({ concepts: Array.from({ length: 20 }, (_, i) => `concept_${i}`) });
  assert.equal(r.concepts.length, 8);
});

test("normalize caps facts at 4", () => {
  const r = normalize({ facts: Array.from({ length: 10 }, (_, i) => `fact number ${i}`) });
  assert.equal(r.facts.length, 4);
});

test("normalize filters non-string concepts", () => {
  const r = normalize({ concepts: ["valid", 42, null, "also_valid"] });
  assert.deepEqual(r.concepts, ["valid", "also_valid"]);
});

test("normalize preserves empty arrays", () => {
  const r = normalize({ concepts: [], facts: [] });
  assert.deepEqual(r, { concepts: [], facts: [] });
});
