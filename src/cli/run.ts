#!/usr/bin/env bun
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { makeHealthReport, type HealthCheckStatus } from "@mazac-fox/opencode-fleet-contracts";
import {
  deleteSubtreeFromHot,
  exportRootSession,
  importArchiveToMemory,
  inspectArchive,
  listArchiveRows,
  restoreArchiveToHot,
  searchArchive,
  staleRootIds,
  verifyArchiveFile,
} from "../archive.ts";
import { formatArtifactIngestSummary, ingestArtifacts } from "../artifacts.ts";
import {
  buildContextBundle,
  formatContextBundle,
  type ContextMode,
  type WorkspaceSignals,
} from "../context.ts";
import { loadConfig, expandArchivePath } from "../config.ts";
import { formatCurationSummary, runCuration } from "../curation.ts";
import { buildDashboardReport, formatDashboardReport } from "../dashboard.ts";
import { buildPluginDashboardReport, formatPluginDashboardReport } from "../plugin-dashboard.ts";
import {
  applyConnPragmas,
  checkSidecarHealth,
  openMemoryDb,
  repairSidecar,
  sidecarPath,
} from "../db.ts";
import { distillRoots, formatDistillSummary } from "../distill.ts";
import { formatContextEvalReport, formatEvalReport, runContextEval, runEval } from "../eval.ts";
import { buildEngramHealthReport, formatEngramHealthReport } from "../health.ts";
import {
  backfillHot,
  formatHotBackfillSummary,
  runBackfillHotJob,
  type BackfillStrategy,
} from "../hot-backfill.ts";
import { formatEventReport, recentLogEvents, type LogLevel } from "../logger.ts";
import { runMaintenance } from "../maintenance.ts";
import { runManualSprint } from "../manual-sprint.ts";
import { defaultHotDbPath } from "../paths.ts";
import { buildMemoryRelations, formatRelationSummary } from "../relations.ts";
import { formatRootIndexSummary, indexHotRoots } from "../root-index.ts";
import { formatTelemetryReport, recentMetrics } from "../telemetry.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

function worktreeFromArgs(args: string[]): string {
  const i = args.indexOf("--worktree");
  const w = i >= 0 ? args[i + 1] : undefined;
  if (w) return path.resolve(w);
  return process.cwd();
}

function projectIdFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--project-id");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return process.env.ENGRAM_PROJECT_ID;
}

function hotPath(cfg: ReturnType<typeof loadConfig>): string {
  return cfg.archive.hotDbPath ?? defaultHotDbPath();
}

function numberArg(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name);
  const raw = i >= 0 ? args[i + 1] : undefined;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function valueArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function levelArg(args: string[]): LogLevel | undefined {
  const raw = valueArg(args, "--level");
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "fatal")
    return raw;
  return undefined;
}

function modeArg(args: string[]): ContextMode {
  const raw = valueArg(args, "--mode");
  if (
    raw === "plan" ||
    raw === "implement" ||
    raw === "review" ||
    raw === "debug" ||
    raw === "audit" ||
    raw === "handoff"
  )
    return raw;
  return "plan";
}

function gitSignals(worktree: string): { changedFiles: string[]; branch: string | null } {
  const diff = Bun.spawnSync(["git", "diff", "--name-only"], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "ignore",
  });
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "ignore",
  });
  const changedFiles =
    diff.exitCode === 0 ? new TextDecoder().decode(diff.stdout).split(/\r?\n/).filter(Boolean) : [];
  const branchName =
    branch.exitCode === 0 ? new TextDecoder().decode(branch.stdout).trim() || null : null;
  return { changedFiles, branch: branchName };
}

function contextSignals(args: string[], worktree: string): WorkspaceSignals | undefined {
  const base: WorkspaceSignals = args.includes("--from-git") ? gitSignals(worktree) : {};
  const signals: WorkspaceSignals = {
    ...base,
    workspaceId: valueArg(args, "--workspace-id"),
    planId: valueArg(args, "--plan-id"),
    correlationId: valueArg(args, "--correlation-id"),
    sessionId: valueArg(args, "--session-id"),
    planSlug: valueArg(args, "--plan-slug"),
    waveId: valueArg(args, "--wave-id"),
    agentRunId: valueArg(args, "--agent-run-id"),
    toolCallId: valueArg(args, "--tool-call-id"),
    spineSeq: numberArg(args, "--spine-seq", 0) || undefined,
    lifecycleObjectIds: repeatedArg(args, "--lifecycle-object-id"),
    artifactRefs: repeatedArg(args, "--artifact-ref"),
    concordEventIds: repeatedArg(args, "--concord-event-id"),
  };
  return Object.values(signals).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  )
    ? signals
    : undefined;
}

function repeatedArg(args: string[], name: string): string[] | undefined {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) continue;
    values.push(
      ...value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return values.length ? values : undefined;
}

function canonicalHealthReport(
  report: ReturnType<typeof buildEngramHealthReport>,
  startedAt: string,
  finishedAt: string,
) {
  return makeHealthReport({
    source: "engram",
    started_at: startedAt,
    finished_at: finishedAt,
    checks: report.checks.map((check) => ({
      name: check.name,
      status: canonicalCheckStatus(check.status),
      message: check.message,
      detail: check.details,
    })),
  });
}

function canonicalCheckStatus(status: "pass" | "warn" | "fail" | "skip"): HealthCheckStatus {
  return status === "pass" ? "ok" : status;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

const knownCommands = [
  "archive",
  "backfill-hot",
  "context",
  "curate",
  "dashboard",
  "doctor",
  "distill",
  "eval",
  "check",
  "index-hot",
  "ingest-artifacts",
  "maintain",
  "repair-sidecar",
  "relations",
  "status",
  "telemetry",
  "sprint",
];

function usage(): string {
  return `Usage:
  engram archive list [--json] [--limit N] [--worktree DIR]
  engram archive export [--json] [--force] <rootSessionId> [--worktree DIR]
  engram archive verify [--json] <rootSessionId> [--worktree DIR]
  engram archive verify-all [--json] [--worktree DIR]
  engram archive inspect [--json] <rootSessionId> [--worktree DIR]
  engram archive restore [--json] [--apply] <rootSessionId> [--worktree DIR]
  engram archive search [--json] <rootSessionId> <query> [--limit N] [--worktree DIR]
  engram archive import-memory [--json] [--apply] <rootSessionId> [--worktree DIR]
  engram archive delete [--vacuum] <rootSessionId> [<rootSessionId>...] [--worktree DIR]
  engram archive export-stale [--json] [--all] [--limit N] [--worktree DIR]
  engram doctor [--json] [--worktree DIR]
  engram status [--json] [--worktree DIR]
  engram check [--json] [--worktree DIR]
  engram ingest-artifacts [--json] [--apply] [--kind journal,plan] [--max N] [--project-id ID] [--worktree DIR]
  engram index-hot [--json] [--apply] [--max N] [--project-id ID] [--worktree DIR]
  engram backfill-hot [--json] [--apply] [--strategy priority|artifact-linked|recent|errors|patches] [--max-roots N] [--max-parts N] [--project-id ID] [--worktree DIR]
  engram distill [--json] [--apply] [--top N] [--project-id ID] [--worktree DIR]
  engram relations [--json] [--apply] [--max N] [--project-id ID] [--worktree DIR]
  engram context <query> [--mode plan|implement|review|debug|audit|handoff] [--json] [--from-git] [--limit N] [--project-id ID] [--worktree DIR]
  engram eval run --fixture FILE [--out DIR] [--live] [--rerank] [--sidecar] [--worktree DIR]
  engram eval query --fixture FILE --query-id ID [--live] [--rerank] [--sidecar] [--worktree DIR]
  engram eval context --fixture FILE [--out DIR] [--query-id ID] [--sidecar] [--worktree DIR]
  engram curate [--json] [--apply|--record] [--max N] [--project-id ID] [--worktree DIR]
  engram dashboard [--json] [--project-id ID] [--worktree DIR]
  engram dashboard --plugins [--json]
  engram maintain [--apply] [--prune-telemetry] [--verify-archives] [--export-stale] [--compact-db] [--health-report] [--project-id ID] [--worktree DIR]
  engram repair-sidecar [--apply] [--worktree DIR]
  engram telemetry [--events] [--json] [--level debug|info|warn|error|fatal] [--limit N] [--project-id ID] [--worktree DIR]
  engram sprint [--rows N] [--local-only] [--rerank] [--worktree DIR]

Examples:
  engram context "workspace memory contract" --mode implement --json --project-id <id>
  engram ingest-artifacts --project-id <id> --worktree /repo
  engram archive import-memory --apply <rootSessionId> --project-id <id> --worktree /repo
  engram maintain --prune-telemetry --apply --project-id <id>`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  if (!knownCommands.includes(argv[0] ?? "")) {
    console.error(usage());
    process.exit(1);
  }

  const wt = worktreeFromArgs(argv);
  const cfg = loadConfig(wt);
  const memoryPath = sidecarPath(wt, cfg);

  if (argv[0] === "doctor" || argv[0] === "status" || argv[0] === "check") {
    const started = new Date().toISOString();
    const report = buildEngramHealthReport({ cfg, worktree: wt, sidecarPath: memoryPath });
    const finished = new Date().toISOString();
    console.log(
      argv.includes("--json")
        ? JSON.stringify(canonicalHealthReport(report, started, finished), null, 2)
        : formatEngramHealthReport(report),
    );
    process.exit(report.status === "fail" ? 1 : 0);
  }

  if (argv[0] === "sprint") {
    const rows = numberArg(argv, "--rows", 3000);
    console.log(
      await runManualSprint({
        cfg,
        rows,
        live: !argv.includes("--local-only"),
        rerank: argv.includes("--rerank"),
      }),
    );
    return;
  }

  if (argv[0] === "repair-sidecar") {
    const health = checkSidecarHealth(memoryPath);
    const repair = repairSidecar({ path: memoryPath, dryRun: !argv.includes("--apply") });
    console.log(`sidecar=${memoryPath}`);
    console.log(`health=${health.ok ? "ok" : "error"}`);
    if (!health.ok) console.log(`error=${health.error}`);
    console.log(`dry_run=${repair.dryRun}`);
    console.log(`repaired=${repair.repaired}`);
    console.log(`quarantine=${repair.quarantineDir}`);
    console.log(`files=${repair.files.length ? repair.files.join(",") : "(none)"}`);
    return;
  }

  const memoryDb = openMemoryDb(memoryPath);
  const hot = hotPath(cfg);
  const home = os.homedir();

  if (argv[0] === "ingest-artifacts") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const kinds = valueArg(argv, "--kind")
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const summary = ingestArtifacts({
      db: memoryDb,
      worktree: wt,
      projectId: pid,
      cfg,
      dryRun: !argv.includes("--apply"),
      kinds,
      max: numberArg(argv, "--max", Number.POSITIVE_INFINITY),
    });
    console.log(
      argv.includes("--json")
        ? JSON.stringify(summary, null, 2)
        : formatArtifactIngestSummary(summary),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "index-hot") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const summary = indexHotRoots({
      db: memoryDb,
      hotPath: hot,
      projectId: pid,
      max: numberArg(argv, "--max", Number.POSITIVE_INFINITY),
      dryRun: !argv.includes("--apply"),
    });
    console.log(
      argv.includes("--json") ? JSON.stringify(summary, null, 2) : formatRootIndexSummary(summary),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "backfill-hot") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const strategy = (valueArg(argv, "--strategy") ?? "priority") as BackfillStrategy;
    if (!argv.includes("--apply")) {
      const summary = backfillHot({
        db: memoryDb,
        hotPath: hot,
        projectId: pid,
        cfg,
        strategy,
        dryRun: true,
        maxRoots: numberArg(argv, "--max-roots", 10),
        maxParts: numberArg(argv, "--max-parts", 500),
      });
      console.log(
        argv.includes("--json")
          ? JSON.stringify({ summary }, null, 2)
          : formatHotBackfillSummary(summary),
      );
    } else {
      const result = runBackfillHotJob({
        db: memoryDb,
        hotPath: hot,
        projectId: pid,
        cfg,
        strategy,
        maxRoots: numberArg(argv, "--max-roots", 10),
        maxParts: numberArg(argv, "--max-parts", 500),
        leaseOwner: "engram-cli",
      });
      console.log(
        argv.includes("--json")
          ? JSON.stringify({ summary: result.summary, job: result.job }, null, 2)
          : formatHotBackfillSummary(result.summary),
      );
    }
    memoryDb.close();
    return;
  }

  if (argv[0] === "distill") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const summary = distillRoots({
      db: memoryDb,
      projectId: pid,
      cfg,
      top: numberArg(argv, "--top", 20),
      dryRun: !argv.includes("--apply"),
    });
    console.log(
      argv.includes("--json") ? JSON.stringify(summary, null, 2) : formatDistillSummary(summary),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "relations") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const summary = buildMemoryRelations({
      db: memoryDb,
      projectId: pid,
      dryRun: !argv.includes("--apply"),
      max: numberArg(argv, "--max", 100),
    });
    console.log(
      argv.includes("--json") ? JSON.stringify(summary, null, 2) : formatRelationSummary(summary),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "context") {
    const pid = projectIdFromArgs(argv);
    const query = argv.filter(
      (x, i) =>
        !x.startsWith("--") &&
        argv[i - 1] !== "--project-id" &&
        argv[i - 1] !== "--worktree" &&
        argv[i - 1] !== "--limit" &&
        argv[i - 1] !== "--mode" &&
        argv[i - 1] !== "--budget" &&
        argv[i - 1] !== "--correlation-id" &&
        argv[i - 1] !== "--session-id" &&
        argv[i - 1] !== "--plan-slug" &&
        argv[i - 1] !== "--wave-id" &&
        argv[i - 1] !== "--agent-run-id" &&
        argv[i - 1] !== "--lifecycle-object-id" &&
        argv[i - 1] !== "--artifact-ref" &&
        argv[i - 1] !== "--concord-event-id",
    )[1];
    if (!pid || !query) {
      console.error("Usage: engram context <query> --project-id <uuid>");
      process.exit(1);
    }
    const bundle = buildContextBundle({
      db: memoryDb,
      projectId: pid,
      query,
      limit: numberArg(argv, "--limit", 12),
      mode: modeArg(argv),
      budgetChars: numberArg(argv, "--budget", 6000),
      workspaceSignals: contextSignals(argv, wt),
      proactiveHintsEnabled: cfg.context.proactiveHints.enabled,
    });
    console.log(
      argv.includes("--json") ? JSON.stringify(bundle, null, 2) : formatContextBundle(bundle),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "telemetry") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const limit = numberArg(argv, "--limit", 200);
    const minLevel = levelArg(argv);
    const metrics = recentMetrics(memoryDb, pid, limit);
    const events = recentLogEvents(memoryDb, pid, { limit, minLevel });
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ metrics, events }, null, 2));
    } else if (argv.includes("--events")) {
      console.log(formatEventReport(events, "CLI"));
    } else {
      console.log(
        [formatTelemetryReport(metrics, "CLI"), formatEventReport(events, "CLI")].join("\n\n"),
      );
    }
    memoryDb.close();
    return;
  }

  if (argv[0] === "eval") {
    const isContextEval = argv[1] === "context";
    const fixture =
      valueArg(argv, "--fixture") ??
      path.join(repoRoot, "eval", "fixtures", isContextEval ? "context-core.json" : "core.json");
    const outDir = valueArg(argv, "--out");
    const queryId = valueArg(argv, "--query-id");
    if (isContextEval) {
      const report = await runContextEval({
        fixturePath: path.resolve(fixture),
        cfg,
        outDir: outDir ? path.resolve(outDir) : undefined,
        memoryDb,
        queryId,
        useSidecar: argv.includes("--sidecar"),
      });
      console.log(formatContextEvalReport(report));
      memoryDb.close();
      return;
    }
    if (argv[1] === "query" && !queryId) {
      console.error("Usage: engram eval query --fixture FILE --query-id ID");
      process.exit(1);
    }
    const report = await runEval({
      fixturePath: path.resolve(fixture),
      cfg,
      outDir: outDir ? path.resolve(outDir) : undefined,
      memoryDb,
      queryId: argv[1] === "query" ? queryId : undefined,
      live: argv.includes("--live"),
      rerank: argv.includes("--rerank"),
      useSidecar: argv.includes("--sidecar"),
    });
    console.log(formatEvalReport(report));
    memoryDb.close();
    return;
  }

  if (argv[0] === "dashboard") {
    if (argv.includes("--plugins")) {
      const report = buildPluginDashboardReport();
      console.log(
        argv.includes("--json")
          ? JSON.stringify(report, null, 2)
          : formatPluginDashboardReport(report),
      );
      memoryDb.close();
      return;
    }
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const report = buildDashboardReport({ db: memoryDb, projectId: pid, cfg, worktree: wt });
    console.log(
      argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDashboardReport(report),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "maintain") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    console.log(
      await runMaintenance({
        memoryDb,
        hotPath: hot,
        projectId: pid,
        cfg,
        home,
        dryRun: !argv.includes("--apply"),
        pruneTelemetry: argv.includes("--prune-telemetry"),
        verifyArchives: argv.includes("--verify-archives"),
        exportStale: argv.includes("--export-stale"),
        compactDb: argv.includes("--compact-db"),
        healthReport:
          argv.includes("--health-report") ||
          !(
            argv.includes("--prune-telemetry") ||
            argv.includes("--verify-archives") ||
            argv.includes("--export-stale") ||
            argv.includes("--compact-db")
          ),
      }),
    );
    memoryDb.close();
    return;
  }

  if (argv[0] === "curate") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const summary = runCuration({
      db: memoryDb,
      projectId: pid,
      apply: argv.includes("--apply"),
      record: argv.includes("--record"),
      max: numberArg(argv, "--max", 100),
    });
    console.log(
      argv.includes("--json") ? JSON.stringify(summary, null, 2) : formatCurationSummary(summary),
    );
    memoryDb.close();
    return;
  }

  const rest = argv.filter(
    (x, i) =>
      !(
        x === "--json" ||
        argv[i - 1] === "--worktree" ||
        x === "--worktree" ||
        argv[i - 1] === "--project-id" ||
        x === "--project-id"
      ),
  );

  if (rest[1] === "list") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error(
        "Pass --project-id <uuid> or set ENGRAM_PROJECT_ID (see project table in opencode.db).",
      );
      process.exit(1);
    }
    const rows = listArchiveRows(memoryDb, pid);
    const archRoot = expandArchivePath(home, cfg.archive);
    const stale = staleRootIds(
      hot,
      pid,
      cfg.archive.staleDays,
      Date.now(),
      numberArg(argv, "--limit", 100),
    );
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ archiveDir: archRoot, hotDb: hot, rows, stale }, null, 2));
      memoryDb.close();
      return;
    }
    console.log(`Archive dir: ${archRoot}`);
    console.log(`Hot db: ${hot}`);
    for (const r of rows) {
      console.log(
        `${r.root_session_id}\tmsgs=${r.message_count}\tparts=${r.part_count}\t${r.archive_path}\t${r.content_hash.slice(0, 12)}…`,
      );
    }
    if (stale.length) console.log(`\nStale roots (${cfg.archive.staleDays}d): ${stale.join(", ")}`);
    memoryDb.close();
    return;
  }

  if (rest[1] === "export-stale") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Pass --project-id or set ENGRAM_PROJECT_ID.");
      process.exit(1);
    }
    const stale = staleRootIds(
      hot,
      pid,
      cfg.archive.staleDays,
      Date.now(),
      numberArg(argv, "--limit", 100),
    );
    const roots = rest.includes("--all") ? stale : stale.slice(0, 1);
    if (roots.length === 0) {
      if (argv.includes("--json")) console.log(JSON.stringify({ exported: [], stale: 0 }, null, 2));
      else console.log("No stale roots.");
      memoryDb.close();
      return;
    }
    const exported: Array<{ root: string; skipped: boolean; path?: string }> = [];
    for (const root of roots) {
      const result = await exportRootSession({
        memoryDb,
        hotPath: hot,
        projectId: pid,
        rootSessionId: root,
        cfg,
        home,
        force: false,
        onProgress: argv.includes("--json") ? undefined : (m) => console.log(m),
      });
      exported.push({ root, skipped: result.skipped, path: result.path });
    }
    if (argv.includes("--json"))
      console.log(JSON.stringify({ exported, stale: stale.length }, null, 2));
    memoryDb.close();
    return;
  }

  if (rest[1] === "export") {
    const force = rest.includes("--force");
    const ids = rest.slice(2).filter((x) => x !== "--force");
    const root = ids[0];
    const pid = projectIdFromArgs(argv);
    if (!root || !pid) {
      console.error(
        "Usage: engram archive export [--force] <rootSessionId>  (requires ENGRAM_PROJECT_ID)",
      );
      process.exit(1);
    }
    const result = await exportRootSession({
      memoryDb,
      hotPath: hot,
      projectId: pid,
      rootSessionId: root,
      cfg,
      home,
      force,
      onProgress: argv.includes("--json") ? undefined : (m) => console.log(m),
    });
    if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    memoryDb.close();
    return;
  }

  if (rest[1] === "verify") {
    const root = rest[2];
    const pid = projectIdFromArgs(argv);
    if (!root || !pid) {
      console.error("Usage: engram archive verify <rootSessionId>");
      process.exit(1);
    }
    const r = await verifyArchiveFile({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
    });
    if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else console.log(r.ok ? r.detail : `FAIL: ${r.detail}`);
    memoryDb.close();
    process.exit(r.ok ? 0 : 1);
  }

  if (rest[1] === "verify-all") {
    const pid = projectIdFromArgs(argv);
    if (!pid) {
      console.error("Usage: engram archive verify-all (requires ENGRAM_PROJECT_ID)");
      process.exit(1);
    }
    const rows = listArchiveRows(memoryDb, pid);
    const archiveRoot = expandArchivePath(home, cfg.archive);
    let ok = true;
    for (const row of rows) {
      const r = await verifyArchiveFile({
        memoryDb,
        archiveRoot,
        projectId: pid,
        rootSessionId: row.root_session_id,
      });
      if (!argv.includes("--json"))
        console.log(`${r.ok ? "OK" : "FAIL"}\t${row.root_session_id}\t${r.detail}`);
      if (!r.ok) ok = false;
    }
    if (argv.includes("--json")) console.log(JSON.stringify({ ok, rows: rows.length }, null, 2));
    else if (rows.length === 0) console.log("No archive rows.");
    memoryDb.close();
    process.exit(ok ? 0 : 1);
  }

  if (rest[1] === "inspect") {
    const root = rest[2];
    const pid = projectIdFromArgs(argv);
    if (!root || !pid) {
      console.error("Usage: engram archive inspect <rootSessionId>");
      process.exit(1);
    }
    const counts = await inspectArchive({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
    });
    console.log(
      argv.includes("--json")
        ? JSON.stringify(counts, null, 2)
        : `sessions=${counts.sessions}\tmessages=${counts.messages}\tparts=${counts.parts}`,
    );
    memoryDb.close();
    return;
  }

  if (rest[1] === "restore") {
    const root = rest.slice(2).find((x) => x !== "--dry-run" && x !== "--apply");
    const pid = projectIdFromArgs(argv);
    if (!root || !pid) {
      console.error("Usage: engram archive restore [--apply] <rootSessionId>");
      process.exit(1);
    }
    const dryRun = !rest.includes("--apply");
    const result = await restoreArchiveToHot({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      hotPath: hot,
      projectId: pid,
      rootSessionId: root,
      dryRun,
    });
    console.log(
      argv.includes("--json")
        ? JSON.stringify(result, null, 2)
        : `${dryRun ? "Would restore" : "Restored"} sessions=${result.sessions} messages=${result.messages} parts=${result.parts}`,
    );
    memoryDb.close();
    return;
  }

  if (rest[1] === "search") {
    const root = rest[2];
    const query = rest[3];
    const pid = projectIdFromArgs(argv);
    if (!root || !query || !pid) {
      console.error("Usage: engram archive search <rootSessionId> <query>");
      process.exit(1);
    }
    const rows = await searchArchive({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
      query,
      limit: numberArg(argv, "--limit", 20),
    });
    console.log(
      argv.includes("--json")
        ? JSON.stringify({ rows }, null, 2)
        : rows.length
          ? rows.join("\n")
          : "No archive matches.",
    );
    memoryDb.close();
    return;
  }

  if (rest[1] === "import-memory") {
    const root = rest.slice(2).find((x) => x !== "--dry-run" && x !== "--apply" && x !== "--json");
    const pid = projectIdFromArgs(argv);
    if (!root || !pid) {
      console.error("Usage: engram archive import-memory [--apply] <rootSessionId>");
      process.exit(1);
    }
    const dryRun = !rest.includes("--apply");
    const result = await importArchiveToMemory({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
      cfg,
      dryRun,
    });
    if (argv.includes("--json")) console.log(JSON.stringify({ ...result, dryRun }, null, 2));
    else
      console.log(
        `${dryRun ? "Would import" : "Imported"} ${result.inserted} chunks from ${result.scannedParts} archived parts.`,
      );
    memoryDb.close();
    return;
  }

  if (rest[1] === "delete") {
    const vacuum = rest.includes("--vacuum");
    const ids = rest.slice(2).filter((x) => x !== "--vacuum");
    const pid = projectIdFromArgs(argv);
    if (!ids.length || !pid) {
      console.error("Usage: engram archive delete [--vacuum] <rootSessionId> ...");
      process.exit(1);
    }
    for (const root of ids) {
      const v = await verifyArchiveFile({
        memoryDb,
        archiveRoot: expandArchivePath(home, cfg.archive),
        projectId: pid,
        rootSessionId: root,
      });
      if (!v.ok) {
        console.error(`Refusing ${root}: archive not verified (${v.detail})`);
        process.exit(1);
      }
    }
    if (!(await confirm(`Delete ${ids.length} session tree(s) from ${hot}? Type yes: `))) {
      console.log("Aborted.");
      memoryDb.close();
      return;
    }
    for (const root of ids) {
      deleteSubtreeFromHot({
        hotPath: hot,
        projectId: pid,
        rootSessionId: root,
        vacuum: false,
      });
      console.log(`Deleted tree ${root}`);
    }
    if (vacuum) {
      const { Database } = await import("bun:sqlite");
      const d = new Database(hot);
      applyConnPragmas(d);
      d.run("VACUUM");
      d.close();
      console.log("VACUUM complete.");
    }
    memoryDb.close();
    return;
  }

  console.error(`Unknown subcommand: ${rest[1]}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
