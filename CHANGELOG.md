# Changelog

All notable changes to ACE are documented here.

## [0.1.0] — 2026-04-16

Initial release.

### Added
- `flag` CLI with 13 commands (`ping`, `recall`, `top`, `eff`, `graph`, `cluster`, `note`, `notes`, `ingest`, `simulate`, `prune`, `export`, `import`, `clear`)
- Pluggable LLM concept extraction (Haiku / claude-cli / ollama) with automatic fallback chain
- Co-occurrence graph — emergent association structure between concepts
- Hybrid notes system — arbitrary facts routed to Markdown notes with frontmatter
- Auto-ingest daemon — continuous processing of new claude-mem observations
- Claude Code plugin — `$ACE` block emitted at SessionStart (~300 tokens)
- Shared persistent store at `~/.claude/flags.json`
- `install.sh` one-command installer (links CLI, registers hook, starts daemon)
- 63+ tests covering decay math, stance, CRUD, graph, notes, router, daemon, hook

### Measured
- 195× compression vs claude-mem full archive (330K → 1.7K tokens)
- 56× smaller session-boot context (17,364 → 308 tokens)
- End-to-end 3,000× compression from raw work (6.1M → 2K tokens)
