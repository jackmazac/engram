# AGENTS.md

This file is the operating guide for agents working in the Engram repository.

Engram is a standalone OpenCode plugin and CLI for local project memory. It turns OpenCode history, plans, audits, journal entries, root-session summaries, evals, telemetry, and selected evidence into bounded context that agents can use before acting.

## Product Boundaries

Engram owns local engineering memory:

- Capture and backfill from OpenCode sessions.
- Sidecar SQLite schema and migrations, including the `chunk_correlation` fleet correlation table.
- Hybrid memory search (FTS + streaming vector + RRF + optional rerank).
- Context compilation through `memory`, `memory_context`, and `engram context` (high-precision and passive by default).
- Fleet correlation retrieval through `conflict_context` (native plugin tool, Wave 3).
- Artifact ingestion through `lifecycle_ingest` (native plugin tool, Wave 3) and `engram ingest-artifacts` CLI.
- Eval fixtures and drift reports.
- Telemetry and event logging.
- Archive export, verify, restore, search, and import-memory workflows.
- Artifact ingest from generic `.opencode` plans, audits, journals, progress, status, handoff, and lifecycle/concord files.
- Root-session indexing, deterministic distillation, relation/supersession graph, curation, and maintenance.

Engram does not own orchestration or fleet control:

- Agent definitions or delegation policy.
- Planner/executor/reviewer/scribe prompts.
- Conductor/Orchestrator workflow rules and lifecycle decisions.
- Live edit coordination and conflict resolution (Concord).
- Code-graph truth, drift detection, API-surface advice (Codemem).
- Fleet install, update, and opencode.json generation (opencode-fleet).
- Global OpenCode config layout.

Conductor integration must stay optional and contract-based. Use `src/bridge-contract.ts` and artifact files; do not hardcode `/Users/jack.mazac/.config/opencode/prompts` or any local prompt path into Engram behavior.

## Non-Negotiable Decisions

- Do not add `sqlite-vec` unless the user explicitly re-approves a canonical backend replacement after eval and telemetry show it is necessary.
- Do not add fallback vector backends. Dual retrieval backends are not architecturally acceptable here.
- The current canonical vector path is streaming brute-force cosine with bounded top-K.
- Do not broaden raw hot DB ingestion as a default learning strategy. Motif proved raw chat/tool history is huge and noisy.
- Prefer artifact-first learning, root indexing, prioritized backfill, distillation, relations, context evals, and context compiler improvements.
- Dashboard remains CLI/TUI/JSON only. Do not add a browser dashboard.
- Privacy/capture policy should be structural and cheap. Avoid broad regex sweeps over large outputs in hot paths.
- Mutating CLI workflows must be dry-run by default unless already documented as safe.
- `memory_context` is passive by default. Do not re-enable proactive injection in default config. The `context.proactiveHints.enabled` gate must be respected throughout the codebase.
- Embeddings, classification, rerank, and broad hybrid memory search require an OpenAI API key. Local context paths (`memory`, `memory_context`, `conflict_context`, `lifecycle_ingest`, `forget`, `stats`) must remain fully functional without one.

## Repository Map

| Path                            | Purpose                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `src/index.ts`                  | OpenCode plugin entry and tool definitions.                                      |
| `src/runtime.ts`                | Long-lived runtime, hooks, write buffer, embedding/classification drains, tools. |
| `src/config.ts`                 | Zod config schema and defaults.                                                  |
| `src/db.ts`                     | Sidecar pragmas and SQLite migrations.                                           |
| `src/capture.ts`                | Converts OpenCode parts/tool outputs/errors into chunk inserts.                  |
| `src/retrieve.ts`               | Hybrid FTS/vector/RRF/rerank retrieval plus authority and feedback scoring.      |
| `src/context.ts`                | Context compiler: modes, hierarchical candidates, sections, reasons, formatting. |
| `src/eval.ts`                   | Retrieval and context evals, synthetic and sidecar-backed.                       |
| `src/artifacts.ts`              | Artifact discovery and ingestion.                                                |
| `src/root-index.ts`             | Hot DB root session indexing and priority scoring.                               |
| `src/hot-backfill.ts`           | Prioritized high-signal hot DB backfill.                                         |
| `src/distill.ts`                | Deterministic root-session distillation.                                         |
| `src/relations.ts`              | Memory relation and supersession graph.                                          |
| `src/dashboard.ts`              | CLI/JSON dashboard reports.                                                      |
| `src/maintenance.ts`            | Maintenance dry-run/apply actions.                                               |
| `src/logger.ts`                 | Bounded lifecycle/failure event logging.                                         |
| `src/telemetry.ts`              | Operation metrics and telemetry formatting.                                      |
| `src/archive.ts`                | Archive export/verify/restore/search/import/delete workflows.                    |
| `src/curation.ts`               | Duplicate and low-value chunk proposal/apply flow.                               |
| `src/bridge-contract.ts`        | Stable types/schemas for optional integrations.                                  |
| `src/cli/run.ts`                | `engram` CLI.                                                                    |
| `eval/fixtures`                 | Checked-in public eval fixtures.                                                 |
| `skills/engram-memory/SKILL.md` | Optional OpenCode agent skill.                                                   |
| `docs`                          | Manual testing, install, bridge, and packaging docs.                             |
| `test`                          | Unit and integration tests.                                                      |

## Database Rules

- All schema changes go through `src/db.ts` migrations.
- Migrations must be monotonic and idempotent for existing sidecars.
- Update `test/db-fts.test.ts` when `PRAGMA user_version` changes.
- Add a regression test for every new table, trigger, or important column family.
- Set `PRAGMA busy_timeout` before lock-sensitive pragmas when changing connection setup.
- Never assume the OpenCode hot DB is small. Motif's hot DB is about 22GB.
- Never scan the hot DB during plugin startup. Delayed legacy backfill exists, but explicit CLI learning commands are preferred.

## Context Compiler Rules

`memory`, `memory_context`, and `engram context` are the flagship Engram surfaces. The default profile is high precision: prefer artifact-backed plans, journals, audits, progress, root distillations, decisions, contracts, bugs, invariants, and test strategy; filter or demote raw hot DB tool/session noise unless it is explicitly requested or correlated.

Context bundles should answer:

- What must the agent know?
- What prior work is relevant?
- What risks or stale decisions exist?
- What worked before?
- What evidence supports this?

Supported modes:

| Mode        | Use before              | Prioritize                                                    |
| ----------- | ----------------------- | ------------------------------------------------------------- |
| `plan`      | Planning/decomposition  | decisions, contracts, requirements, audits, risks             |
| `implement` | Code changes            | API contracts, invariants, migrations, prior successful paths |
| `review`    | Code review             | invariants, reviewer failures, bugs, test strategy            |
| `debug`     | Failure analysis        | errors, failed commands, root-cause fixes, perf notes         |
| `audit`     | Wide analysis           | prior audits, coverage gaps, product requirements, risks      |
| `handoff`   | Scribe/session transfer | latest plans, progress, journal, distillations                |

Every context item should include a useful `why` explanation. Keep this debuggable and deterministic.

Do not reintroduce query expansion unless the user explicitly approves it. The prior approval excluded rank 8 query expansion, rank 9 context cache, and rank 10 additional raw backfill.

`memory` without `scope` should return the same evidence-oriented context shape as `memory_context`. Use `scope: "broad"` or `scope: "forensic"` only for raw hybrid search when an agent explicitly needs lower-level session evidence.

## Fleet Correlation (chunk_correlation Sidecar)

Wave 3 adds a nullable sidecar table `chunk_correlation` in `src/db.ts`. It attaches fleet IDs to chunks without widening the hot write path:

| Column               | Type    | Index |
| -------------------- | ------- | ----- |
| `chunk_id`           | TEXT PK | —     |
| `workspace_id`       | TEXT    | yes   |
| `plan_id`            | TEXT    | yes   |
| `wave_id`            | TEXT    | yes   |
| `agent_run_id`       | TEXT    | yes   |
| `correlation_id`     | TEXT    | yes   |
| `tool_call_id`       | TEXT    | yes   |
| `spine_seq`          | INTEGER | yes   |
| `artifact_ref`       | TEXT    | yes   |
| `lifecycle_object_id`| TEXT    | yes   |

All columns are nullable. A missing row means the chunk pre-dates correlation tracking; it is still valid. Rows are written by `upsertChunkCorrelation` in `src/db.ts` during new captures and artifact ingestion when a valid fleet context is present.

Engram may receive the full host-supplied `FleetContext`, but the exact sidecar only persists the columns listed above. `plan_slug` remains on the hot `chunk` table, and `concord_event_id` / `concord_event_ids` plus `fleet_run_id` are retrieval/ranking signals rather than exact `chunk_correlation` filters. Do not imply those fields are SQLite-indexed unless you add a nullable migration, write/read support, and tests.

To query by fleet IDs directly in SQLite:

```sql
SELECT c.* FROM chunk c
JOIN chunk_correlation cc ON cc.chunk_id = c.id
WHERE cc.plan_id = 'fleet-correlation' AND cc.wave_id = 'W3';
```

**Schema rules for this table**: additive-only; new columns must be nullable and use `ALTER TABLE … ADD COLUMN … IF NOT EXISTS` in a new migration block; never widen the hot write path.

## Passivity Default (W3.5)

`memory_context` and `engram context` are **passive by default**. They return an evidence bundle and nothing else:

- No `suggestedNextSteps` field.
- No `<engram-hint>…</engram-hint>` injection into the system prompt.
- No `<project_memory>…</project_memory>` injection.

To re-enable proactive injection, set in `.opencode/engram.jsonc`:

```json
{
  "context": {
    "proactiveHints": {
      "enabled": true
    }
  }
}
```

The `config.context.proactiveHints.enabled` flag is defined in `src/config.ts`. Regression tests must verify that the default (flag absent or `false`) produces no `suggestedNextSteps` and no injected blocks. Do not introduce any code path that emits hints outside this gate.

## Non-Blocking Runtime Safety

Engram is optional memory infrastructure. It must never become part of OpenCode's critical path for normal chat, tool execution, or plugin loading.

- Plugin load must be fail-soft. Do not synchronously open, migrate, or repair the sidecar in `EngramPlugin`; use the lazy `EngramRuntimeHandle` path from `src/runtime.ts`.
- Ambient hooks (`event`, `tool.execute.after`, `session.idle`, `experimental.chat.system.transform`) must never throw into OpenCode. Catch synchronous failures and promise rejections, including delayed microtask work.
- Ambient hooks should enqueue or skip work only. Do not run sidecar writes, hot DB scans, archive export, artifact ingest, embedding, classification, or retrieval directly from a hook body.
- `experimental.chat.system.transform` must be best-effort and deadline-bound through `runtime.systemTransformDeadlineMs`. Use a shadow copy and only commit mutations when the work completes before the deadline.
- The live plugin path must use `openMemoryDbLive` or equivalent short-timeout SQLite pragmas. Keep longer `openMemoryDb` maintenance timeouts for CLI, eval, repair, archive, and explicit maintenance workflows.
- Degraded runtime responses must stay passive by default. Do not emit `suggestedNextSteps`, `<engram-hint>`, or `<project_memory>` from degraded paths unless `context.proactiveHints.enabled` explicitly gates that behavior.
- Explicit tools may perform requested work, but they must return structured degraded/error output instead of throwing when runtime startup, SQLite, OpenAI, or filesystem access fails.
- Add regression tests whenever changing runtime startup, hook dispatch, system transform injection, SQLite connection setup, or degraded tool behavior. Cover corrupt/locked sidecars, async hook failures, and deadline behavior.

## Native Plugin Tool Pattern

`conflict_context` and `lifecycle_ingest` are the reference examples for adding a native plugin tool (as opposed to a CLI command). The pattern in `src/index.ts`:

1. Define the Zod input schema inline or import it from the relevant source module.
2. Call `tool({ description, parameters, execute })` — `execute` receives the validated args and the OpenCode context object.
3. Register the tool in the `tools` map returned by the plugin's `create` function.
4. Do not shell out to other fleet plugins from inside `execute`. Call internal Engram functions directly.
5. Add a contract test in `test/plugin-contract.test.ts` that asserts the tool is exported and its schema accepts/rejects expected shapes.

For retrieval-backed tools, call `hybridSearch` (or the relevant pipeline function in `src/retrieve.ts`) directly; do not re-implement retrieval logic in the tool handler.

## Extending Retrieval Ranking

To add a new ranking signal:

1. Add the signal computation to `src/retrieve.ts` (the `scoreChunk` function or a post-merge pass).
2. Update `RRFResult` in `src/retrieve.ts` if the signal needs to be surfaced to callers.
3. Add or update a retrieval fixture in `eval/fixtures/` that exercises the new signal.
4. Run `bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree .` and confirm 100%.
5. Add a unit test in `test/` that verifies the signal is applied correctly for edge cases.

Do not add ranking signals that require an OpenAI call in the hot retrieval path. OpenAI rerank is a post-retrieval optional step gated by `retrieval.rerank`.

## Adding a New Artifact Kind

Artifact kinds are inferred from file path and metadata in `src/artifacts.ts`. To add a new kind:

1. Update the kind-detection logic in `src/artifacts.ts`.
2. Update `ArtifactKind` type if one is defined.
3. Add a fixture entry in an existing or new eval fixture that exercises the new kind.
4. Update `test/learning-modules.test.ts` to cover ingest behavior for the new kind.

The contracts package defines which artifact kinds fleet tools emit; Engram infers kind from file metadata. Do not hardcode absolute `.opencode/` paths into artifact detection; use the `worktree` parameter to anchor lookups.

## Canonical Contracts Boundary

`src/bridge-contract.ts` and the `@mazac-fox/opencode-fleet-contracts` package are the canonical shared types for fleet integration. When `conflict_context` or `lifecycle_ingest` decode an incoming `FleetContext` object:

- Decode at the plugin boundary (in the tool `execute` handler), not deep in internal functions.
- Use the Zod schema from `bridge-contract.ts` or the contracts package — do not redefine the shape.
- Internal Engram functions should receive already-decoded, narrowed types — not raw `unknown`.
- One decode boundary per tool; no mapper hops after that point.

## What Agents Do NOT Do Here

- Do not implement orchestration policy, delegation rules, or multi-agent workflow logic in Engram. Those belong in Conductor.
- Do not make lifecycle decisions (approve plans, assign tasks, route work). Engram stores and retrieves; it does not decide.
- Do not shell out or call other fleet plugins from inside Engram plugin tool handlers. Use native function calls.
- Do not break retention defaults (14d metrics / 14d events / 5000 event rows) without explicit user approval. Pruning is user-initiated.
- Do not widen the hot write path for correlation IDs. Use the `chunk_correlation` sidecar table.
- Do not add a browser-based dashboard. Dashboard is CLI/TUI/JSON only.
- Do not add `sqlite-vec` or a second vector backend without a full eval/telemetry justification and explicit user approval.

## Eval Rules

Engram has two eval families:

- Retrieval eval: `engram eval run`.
- Context eval: `engram eval context`.

Fixtures have two modes:

- Synthetic fixtures include `chunks` and seed a temporary sidecar. Run without `--sidecar`.
- Sidecar-backed fixtures use an existing project `memory.db`. Run with `--sidecar`; expected IDs must already exist in that sidecar.

Public fixtures belong in `eval/fixtures`. Private project fixtures, such as Motif fixtures, belong under that project's `.opencode/engram-eval/` directory and must not be committed to this repo.

Core checks:

```bash
bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree .
bun run ./src/cli/run.ts eval context --fixture eval/fixtures/context-core.json --worktree .
```

Expected public fixture quality should remain 100% unless a deliberate fixture or ranking change is made.

## Capture And Backfill Rules

- Capture policy defaults deny completed `read`, `grep`, and `glob` tool outputs.
- Completed tool output is not captured unless `capture.policy.captureCompletedToolOutput` is enabled.
- Error output is captured when `capture.policy.captureErrorToolOutput` is enabled, bounded by `maxToolOutputLength`.
- Prefer artifact ingestion before hot DB backfill.
- Prefer `backfill-hot --strategy priority` or `artifact-linked` over legacy chronological backfill.
- Legacy auto backfill is opt-in and must never run in the live plugin runtime by default.

## Telemetry And Logging Rules

- Metrics live in `operation_metric` and are handled by `src/telemetry.ts`.
- Lifecycle/failure events live in `log_event` and are handled by `src/logger.ts`.
- Logs are operational breadcrumbs, not product memory.
- Logger failures must never break plugin hooks or CLI operations.
- Log details must be bounded by config.
- `maintain --prune-telemetry --apply` should prune both metrics and events.

## CLI Safety Rules

- Mutating commands should be dry-run by default unless a command has a very clear safe behavior.
- Archive restore writes to the hot OpenCode DB. Test restore against a copied DB before real usage.
- Motif and other real worktrees can have many unrelated local changes. Do not modify them unless explicitly asked.
- When running multiple CLI commands against the same sidecar, prefer serial commands for smoke checks to avoid lock contention.

## Local Motif Notes

Motif is a useful stress test, not a fixture to commit.

- Motif worktree: `/Users/jack.mazac/Developer/execintel`.
- Motif project ID: `7bc5e857ac92adfe3c30f26082cb9326e0bcd927`.
- Motif sidecar: `/Users/jack.mazac/Developer/execintel/.opencode/memory.db`.
- Motif local eval fixtures belong under `/Users/jack.mazac/Developer/execintel/.opencode/engram-eval/`.

Useful smoke commands:

```bash
PROJECT=7bc5e857ac92adfe3c30f26082cb9326e0bcd927
WT=/Users/jack.mazac/Developer/execintel

bun run ./src/cli/run.ts dashboard --project-id "$PROJECT" --worktree "$WT"
bun run ./src/cli/run.ts context "brief persistence auto update connector" --mode plan --project-id "$PROJECT" --worktree "$WT"
bun run ./src/cli/run.ts eval context --sidecar --fixture "$WT/.opencode/engram-eval/motif-context-live.json" --worktree "$WT"
```

## Verification Commands

Run from the repo root:

```bash
bun run check
bun run smoke:runtime
git diff --check
npm pack --dry-run
```

`bun run check` runs lint, typecheck, and the full test suite. `bun run smoke:runtime` exercises the live plugin runtime path against an in-memory sidecar without OpenAI. For changed eval/context behavior, also run:

```bash
bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree .
bun run ./src/cli/run.ts eval context --fixture eval/fixtures/context-core.json --worktree .
```

For package confidence after public-facing changes, run `npm pack --dry-run` and confirm expected package contents.

## Testing Guidance

- Prefer small deterministic tests over live API tests.
- Live OpenAI tests are optional and gated by key resolution.
- Use temporary sidecars for DB tests.
- Sidecar-backed eval tests should create their own temporary `memory.db` unless deliberately validating a real project.
- Add tests for every new CLI-visible behavior when possible.

Important test files:

| Test                            | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `test/eval.test.ts`             | Retrieval/context evals and sidecar-backed eval behavior.               |
| `test/learning-modules.test.ts` | Artifact ingest, context, root index, hot backfill, distill, relations. |
| `test/db-fts.test.ts`           | Migrations and FTS behavior; includes `chunk_correlation` table checks. |
| `test/telemetry.test.ts`        | Metrics and event logging.                                              |
| `test/capture-policy.test.ts`   | Structural capture policy.                                              |
| `test/startup.test.ts`          | Startup/backfill scheduling defaults.                                   |
| `test/plugin-contract.test.ts`  | OpenCode tool surface; asserts all 7 tools are exported.                |

## Packaging Rules

- Package name is `opencode-engram`.
- Repository is `https://github.com/jackmazac/opencode-engram`.
- Keep `package.json` `exports` aligned with actual public surfaces.
- Keep `package.json` `files` aligned with docs, fixtures, source, and skill content.
- Do not publish private Motif fixtures.
- The optional skill lives at `skills/engram-memory/SKILL.md`.

## Git Rules

- Use concise conventional-style commit messages, usually `feat:` or `fix:`.
- Run verification before committing.
- Do not commit `.opencode/`, sidecar DB files, WAL/SHM files, local eval runs, or private Motif fixtures.
- The configured `origin` may not point at `opencode-engram`; pushing has been done with:

```bash
git push https://github.com/jackmazac/opencode-engram.git HEAD:main
```

## Conductor Boundary

The separate orchestration package scaffold is `/Users/jack.mazac/Developer/opencode-conductor`.

Conductor and other fleet plugins consume Engram through:

- Native plugin tools: `conflict_context` and `lifecycle_ingest` are registered tools callable from any agent that loads the Engram plugin.
- OpenCode tools such as `memory_context`, `memory`, `memory_feedback`, and `stats`.
- Artifact files that Engram can ingest via `lifecycle_ingest` or `engram ingest-artifacts`.
- Types and schemas from `opencode-engram/bridge`.

Do not move Conductor prompt logic or multi-agent workflow policy into Engram. Do not shell out to Engram from Conductor — use the native tool dispatch path.

## Working Principles

- Prefer high-authority artifacts over raw chat.
- Prefer bounded context over large dumps.
- Prefer deterministic local computation over LLM calls in hot paths.
- Prefer eval-backed changes over intuition.
- Prefer explicit dry-run/apply workflows for anything mutating.
- Preserve Engram's standalone usability for community OpenCode users.
