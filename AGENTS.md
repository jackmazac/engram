# AGENTS.md

This file is the operating guide for agents working in the Engram repository.

Engram is a standalone OpenCode plugin and CLI for local project memory. It turns OpenCode history, plans, audits, journal entries, root-session summaries, evals, telemetry, and selected evidence into bounded context that agents can use before acting.

## Product Boundaries

Engram owns local engineering memory:

- Capture and backfill from OpenCode sessions.
- Sidecar SQLite schema and migrations.
- Hybrid memory search.
- Context compilation through `memory_context` and `engram context`.
- Eval fixtures and drift reports.
- Telemetry and event logging.
- Archive export, verify, restore, search, and import-memory workflows.
- Artifact ingest from generic `.opencode` plans, audits, journals, progress, status, and handoff files.
- Root-session indexing, deterministic distillation, relation/supersession graph, curation, and maintenance.

Engram does not own orchestration:

- Agent definitions.
- Delegation policy.
- Planner/executor/reviewer/scribe prompts.
- Conductor/Orchestrator workflow rules.
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

`memory_context` and `engram context` are the flagship Engram surfaces.

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
- Legacy auto backfill is delayed by default and should never block startup.

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
bun run typecheck
git diff --check
bun test --timeout 30000
npm pack --dry-run
```

For changed eval/context behavior, also run:

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
| `test/db-fts.test.ts`           | Migrations and FTS behavior.                                            |
| `test/telemetry.test.ts`        | Metrics and event logging.                                              |
| `test/capture-policy.test.ts`   | Structural capture policy.                                              |
| `test/startup.test.ts`          | Startup/backfill scheduling defaults.                                   |
| `test/plugin-contract.test.ts`  | OpenCode tool surface.                                                  |

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

Conductor should consume Engram through:

- OpenCode tools such as `memory_context`.
- Artifact files that Engram can ingest.
- Types and schemas from `opencode-engram/bridge`.

Do not move Conductor prompt logic or multi-agent workflow policy into Engram.

## Working Principles

- Prefer high-authority artifacts over raw chat.
- Prefer bounded context over large dumps.
- Prefer deterministic local computation over LLM calls in hot paths.
- Prefer eval-backed changes over intuition.
- Prefer explicit dry-run/apply workflows for anything mutating.
- Preserve Engram's standalone usability for community OpenCode users.
