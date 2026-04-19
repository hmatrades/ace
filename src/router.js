// ACE routing layer
//
// Takes an extract() result {concepts, facts} plus optional context (source
// observation text, primary concept), and routes:
//   - concepts → flag pings (with cooc updates via recordPingSync)
//   - facts    → notes, linked to the primary concept
//
// This is the "one call to process everything" API the daemon uses.

import { loadFlags, saveFlags, dayNow, DEFAULT_HL } from "./store.js";
import { recordPingSync } from "./graph.js";
import { writeNote, slugify } from "./notes.js";

/**
 * Ingest an extraction result into the shared store.
 *
 * @param {Object} extraction - {concepts: string[], facts: string[]}
 * @param {Object} opts
 * @param {string} opts.source  - raw source text, for note provenance
 * @param {number} opts.halfLife - override default HL for new flags
 * @returns {Object} summary {pinged: string[], notes: string[]}
 */
export function ingest(extraction, opts = {}) {
  const { concepts = [], facts = [] } = extraction || {};
  const flags = loadFlags();
  const now = dayNow();
  const hl = opts.halfLife || DEFAULT_HL;

  // 1. Ping every concept (creates/bumps + builds cooc in ping window)
  const pinged = [];
  for (const raw of concepts) {
    const c = slugify(raw).replace(/-/g, "_");
    if (!c) continue;
    if (flags[c]) {
      flags[c].hits++;
      flags[c].seen = now;
    } else {
      flags[c] = { hits: 1, seen: now, hl };
    }
    recordPingSync(c, flags);
    pinged.push(c);
  }

  // 2. Facts route to notes, linked to the first concept if any
  const primaryConcept = pinged[0];
  const writtenNotes = [];
  if (facts.length) {
    const noteSlug = primaryConcept || slugify(opts.source || "general");
    writeNote(noteSlug, {
      meta: primaryConcept ? { linked_flag: primaryConcept } : {},
      facts,
    });
    writtenNotes.push(noteSlug);

    // If a linked flag exists, record the note reference on the flag
    if (primaryConcept && flags[primaryConcept]) {
      flags[primaryConcept].note = noteSlug;
    }
  }

  saveFlags(flags);
  return { pinged, notes: writtenNotes };
}

/**
 * Shortcut: extract text then ingest. Useful for daemon / one-shot scripts.
 */
export async function extractAndIngest(text, opts = {}) {
  const { extract } = await import("./extract.js");
  const result = await extract(text);
  return ingest(result, { source: text, ...opts });
}
