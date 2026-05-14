# Engram

OpenCode plugin and CLI for **local project memory**: sidecar SQLite (`memory.db`), hybrid retrieval (FTS + streaming vector + RRF), context compilation, artifact ingest, evals, archives, and telemetry.

## What it is

- **Plugin tools**: `memory`, `memory_context`, `conflict_context`, `lifecycle_ingest`, `memory_feedback`, `forget`, `stats`.
- **CLI**: `bun run ./src/cli/run.ts` (see package `"bin"` for `engram` when linked).
- **Config**: `.opencode/engram.jsonc` per worktree; schema in `src/config.ts`.

Correlation for fleet IDs uses the **`chunk_correlation`** sidecar (narrow columns only). `memory_context` is **passive by default** (no injected hints unless `context.proactiveHints.enabled`).

## Quick start

```json
{
  "plugin": ["file:///path/to/engram/src/index.ts"]
}
```

Optional OpenAI key for embeddings/rerank; local paths work without it. Repository: [github.com/jackmazac/opencode-engram](https://github.com/jackmazac/opencode-engram).

## Development

```bash
bun install
bun run check
bun run smoke:runtime
```

Eval fixtures: `eval/fixtures/`. Full conventions: **`AGENTS.md`**.

## Fleet position

| Owns | Does not own |
|------|----------------|
| Memory, ingest, retrieval, context bundles, archives | Orchestration (Conductor), code-graph (Codemem), locks (Concord), fleet CLI (opencode-fleet) |

## License

MIT
