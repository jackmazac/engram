# Engram

OpenCode plugin that stores a **project memory** sidecar (`memory.db`): FTS5 full-text search, embedding blobs, cosine retrieval, RRF merge, optional LLM rerank. It captures session text and tool traces, exposes **`memory`**, **`forget`**, and **`stats`** tools, can inject **`<project_memory>`** into the system prompt, and ships a small **`engram`** CLI for archive export and maintenance.

**Repository:** [github.com/jackmazac/engram](https://github.com/jackmazac/engram)

## Requirements

- [Bun](https://bun.sh) (runtime and tests)
- An **OpenAI API key** (or compatible usage) for embeddings, classification batches, and rerank when enabled

## Install (OpenCode)

Use a **`file://`** URL to the plugin entry (OpenCode imports it directly; no publish step required):

```json
{
  "plugin": [
    "file:///Users/you/Developer/engram/src/index.ts"
  ]
}
```

Adjust the path to your clone. Restart OpenCode after changing `plugin`.

Per **worktree**, optional overrides live in **`.opencode/engram.jsonc`** (or `engram.json`), merged on top of built-in defaults. The schema is defined in [`src/config.ts`](src/config.ts) (`defaultEngramConfig`).

## API key

Resolution order (see [`src/openai.ts`](src/openai.ts)):

1. `openaiApiKey` in `engram.jsonc`
2. Environment variable **`OPENAI_API_KEY`**
3. **macOS Keychain** — generic password: service **`OPENAI_KEYCHAIN_SERVICE`** (default `OPENAI_API_KEY`), optional account **`OPENAI_KEYCHAIN_ACCOUNT`**

Example Keychain item:

```bash
security add-generic-password -s OPENAI_API_KEY -a default -w "sk-..."
```

## Tools

| Tool | Purpose |
|------|---------|
| `memory` | Search memory (FTS + vector + merge; optional rerank). |
| `forget` | Drop chunks matching a pattern / scope (see config limits). |
| `stats` | Sidecar stats (counts, embedding health, etc.). |

## CLI (`engram`)

From a clone of this repo:

```bash
bun install
export ENGRAM_PROJECT_ID=<uuid-from-opencode-project-table>
# optional: --project-id <uuid>

bun run ./src/cli/run.ts archive list --worktree /path/to/project
bun run ./src/cli/run.ts archive export <rootSessionId> [--force] --worktree /path/to/project
bun run ./src/cli/run.ts archive export-stale --worktree /path/to/project
bun run ./src/cli/run.ts archive verify <rootSessionId> --worktree /path/to/project
bun run ./src/cli/run.ts archive delete [--vacuum] <rootSessionId> ... --worktree /path/to/project
```

`archive delete` expects a prior successful **`verify`**. Practice on a **copy** of `opencode.db` until you trust the flow.

The [`package.json`](package.json) `"bin"` field exposes the same entry as the `engram` command if you `bun link` or install the package locally.

## Verify it is working

1. Load the plugin via `file://`, open a project, send an assistant turn.
2. Check **`.opencode/memory.db`** for `chunk` / `chunk_fts` rows.
3. Invoke **`memory`** from an agent and confirm hits / `retrieval_log`.
4. With **`proactive.enabled`**, confirm `<project_memory>` appears on normal chat sessions that carry a `sessionID` (paths without a session skip injection).

## Development

Run from **this directory** (not a monorepo root):

```bash
bun install
bun typecheck
bun test
```

Tests include an **optional live** suite (`test/openai-live-nano.test.ts`) when a key resolves via env or Keychain. Performance checks use a real in-memory SQLite path in `test/perf-operations.test.ts`.

## Performance (expectations)

- Capture enqueue is designed to stay lightweight on typical dev hardware.
- Archive export throughput depends on `archive.batchSize` and DB size; ballpark on the order of seconds per thousand messages is normal.

## License

MIT
