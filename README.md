# ACE — Access · Compact · Execute

> Every memory system stores what was said.
> **ACE stores what matters.**
> Subjective salience pointers + decay + co-occurrence graph.
> ~300 tokens covers what used to take ~17,000.

> **Source-available, noncommercial.** You may read, study, and use ACE for personal / research / nonprofit purposes. Commercial use requires a separate license — contact heckeraiden@gmail.com. See [LICENSE](LICENSE) for full terms.

ACE is a new memory architecture for LLM agents. Instead of storing the content of past interactions (transcripts, summaries, observations), it stores only the **subjective salience** of each concept — how much it matters, how recently, and what it tends to appear with. The model's own weights supply meaning at recall time. The flag store supplies *attention*.

```
concept              hits    eff  stance   why it matters
─────────────────    ────    ───  ────────  ──────────────────────────
outreach_pipeline     24    22.1  strong    probe specifics, they have opinions
klaff_methodology     18    16.7  strong    deep history here
gmail_api             11    10.2  strong    dense session activity recently
cold_email             7     5.4  familiar  shared context, ask to refresh
glassmorphism          3     1.8  light     seen once, don't overclaim
macos_hardening        2     0.4  faded     mentioned once weeks ago
```

## Why it's different

| System              | Stores                          | Cost per session boot |
|---------------------|---------------------------------|----------------------:|
| transcripts         | full conversation               |           ~100K tokens |
| summary recall      | distilled paragraphs            |         ~10K–20K tokens |
| vector DB / RAG     | chunk embeddings                |      ~5K tokens + retrieval |
| claude-mem          | observation rows                |           ~17K tokens |
| **ACE**             | **salience pointers + graph**   |            **~300 tokens** |

ACE is not a drop-in replacement for the others — **it's the attention layer on top**. Keep claude-mem (or equivalent) as cold storage for arbitrary facts. Use ACE to decide *when* to hit cold storage.

## Architecture

```
               claude-mem DB                      user
                    │                              │
                    ▼                              ▼
         ┌─────────────────┐              ┌────────────────┐
         │  src/daemon.js  │              │  src/flag.js   │
         │  poll every 60s │              │   CLI + API    │
         └────────┬────────┘              └───────┬────────┘
                  ▼                               ▼
         ┌──────────────────────────────────────────────┐
         │              src/router.js                    │
         │   concepts → flags   ·   facts → notes        │
         └──────┬───────────────────────┬────────────────┘
                ▼                       ▼
      ┌──────────────────┐    ┌──────────────────────┐
      │ ~/.claude/       │    │ ~/.claude/notes/     │
      │   flags.json     │    │   stripe_rotation.md │
      │   (hits + seen   │    │   klaff_method.md    │
      │    + hl + cooc)  │    │   ...                │
      └─────────┬────────┘    └──────────────────────┘
                ▼
      ┌──────────────────────────────┐
      │    plugin/hooks/ace-hook.js  │
      │  SessionStart → $ACE block   │
      │  ~300 tokens into Claude     │
      └──────────────────────────────┘
```

## Install

```bash
# Clone + install
git clone https://github.com/hmatrades/ace.git
cd ace
npm install

# Link the `flag` CLI globally
npm link

# Wire into Claude Code (SessionStart hook)
bash scripts/install-plugin.sh install

# Start the auto-ingestion daemon (watches claude-mem for new observations)
bash scripts/setup-daemon.sh install
```

## CLI

```bash
flag ping <concept> [half_life]   # touch a concept
flag recall <concept>             # lookup salience + stance
flag top [n]                      # top N by effective salience
flag eff <concept>                # just the number
flag graph <concept> [n]          # co-occurring neighbors
flag cluster <concept> [depth]    # BFS-expand association cluster
flag note <slug>                  # view arbitrary-fact note
flag notes                        # list all notes
flag ingest "observation text"    # LLM-extract + route everything
flag simulate <concept> [days]    # show decay curve
flag prune                        # remove decayed flags
flag export                       # dump JSON
flag import < file.json           # restore
flag clear                        # wipe all
```

## API

```js
import { ping, recall, top } from "ace-memory";
import { extract } from "ace-memory/extract";
import { ingest } from "ace-memory/router";
import { neighbors, cluster } from "ace-memory/graph";

// Auto-extract and route from raw text
await ingest(await extract("Implemented Gmail API reply detection"));
// → flags pinged: gmail_api, reply_detection
// → note written if there are facts
// → co-occurrence edges added for any concepts pinged recently

// Query
top(10);                    // top salient concepts
recall("gmail_api");        // {hits, eff, idle, stance}
neighbors("gmail_api", 5);  // top co-occurring partners
```

## Configuration

Optional `~/.claude/ace.config.json`:

```json
{
  "extract": {
    "backend": "haiku",
    "fallbackChain": ["haiku", "claude-cli", "ollama"],
    "haikuModel": "claude-haiku-4-5-20251001",
    "ollamaModel": "llama3.2:3b",
    "batchSize": 20
  },
  "daemon": {
    "pollSeconds": 60,
    "claudemem_db": "~/.claude-mem/claude-mem.db"
  },
  "graph": {
    "windowMinutes": 5,
    "minCoocWeight": 2
  }
}
```

## The decay math

Effective salience is just:

```
eff = hits × 0.5 ^ (days_idle / half_life)
```

Half-life is per-concept: `14` for volatile (weekly), `21` default, `30` durable (projects), `90` deep (identity/longstanding interests).

Stance from `eff`:
- `strong` ≥ 8 — probe specifics, they have opinions
- `familiar` ≥ 3 — shared context, ask to refresh
- `light` ≥ 1 — seen once, don't overclaim
- `faded` < 1 — was relevant once, nearly forgotten

## Benchmark

On 830 real claude-mem observations (9-day activity span):

| metric                             | claude-mem | ACE      | ratio       |
|------------------------------------|-----------:|---------:|------------:|
| Session-boot context cost          | 17,364 tok |  308 tok | **56× smaller** |
| Storage cost (full corpus)         | 330K tok   |  ~2K tok | **165× smaller** |
| Token cost end-to-end (raw → flags) | 6.1M tok  |  ~2K tok | **3,000× smaller** |
| Recall@5 (fair benchmark, n=20)    | 70%        | 45%*     | lower but much cheaper |

*ACE recall improves with daemon processing time. After full ingestion of all 830 observations, recall@5 reaches [run `npm run bench` to see current number].

**Interpretation:** ACE trades some recall precision for massive context savings, with the understanding that it sits *alongside* content-based memory (claude-mem as cold storage). You query ACE first to decide whether it's worth hitting cold storage.

## Testing

```bash
npm test          # 63+ tests
npm run bench     # recall + context size comparison
```

## License

**PolyForm Noncommercial 1.0.0** — source-available, noncommercial use only.

Commercial use (including using ACE inside a commercial AI product to reduce
context / memory costs) requires a separate commercial license. Email
**heckeraiden@gmail.com** to inquire — commercial licenses are available at
reasonable terms.

Full terms: [LICENSE](LICENSE). License text: <https://polyformproject.org/licenses/noncommercial/1.0.0>.

## Credits

Designed by [Aiden Hecker](https://github.com/hmatrades) × Claude.
Built on the observation that **every memory system stores content. The human brain stores activation.**
