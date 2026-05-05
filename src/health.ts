import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { EngramConfig } from "./config.ts";
import { applyConnPragmas, checkSidecarHealth, countStaleBackfillJobs } from "./db.ts";

export type EngramHealthStatus = "pass" | "warn" | "fail" | "skip";

export type EngramHealthCheck = {
  name: string;
  status: EngramHealthStatus;
  message: string;
  details?: unknown;
};

export type EngramHealthReport = {
  status: Exclude<EngramHealthStatus, "skip">;
  worktree: string;
  sidecarPath: string;
  checks: EngramHealthCheck[];
  summary: Record<EngramHealthStatus, number>;
};

const LARGE_DB_BYTES = 500 * 1024 * 1024;
const LARGE_WAL_BYTES = 128 * 1024 * 1024;

export function buildEngramHealthReport(opts: {
  cfg: EngramConfig;
  worktree: string;
  sidecarPath: string;
}): EngramHealthReport {
  const checks: EngramHealthCheck[] = [];

  checks.push({
    name: "config enabled",
    status: opts.cfg.enabled ? "pass" : "warn",
    message: opts.cfg.enabled ? "Engram capture is enabled" : "Engram capture is disabled",
  });
  checks.push({
    name: "telemetry enabled",
    status: opts.cfg.telemetry.enabled ? "pass" : "warn",
    message: opts.cfg.telemetry.enabled
      ? "telemetry retention is enabled"
      : "telemetry is disabled",
  });
  checks.push({
    name: "runtime auto backfill",
    status: opts.cfg.backfill.auto ? "warn" : "pass",
    message: opts.cfg.backfill.auto
      ? "legacy hot DB backfill is enabled in the live runtime"
      : "legacy hot DB backfill is opt-in and disabled for runtime safety",
  });
  checks.push({
    name: "broad vector candidate cap",
    status: opts.cfg.memorySearch.maxVectorCandidates > 0 ? "pass" : "warn",
    message:
      opts.cfg.memorySearch.maxVectorCandidates > 0
        ? `broad vector search is capped at ${opts.cfg.memorySearch.maxVectorCandidates} candidates`
        : "broad vector search has no candidate cap",
  });
  checks.push(sidecarHealthCheck(opts.sidecarPath));
  checks.push(sizeCheck("sidecar size", opts.sidecarPath, LARGE_DB_BYTES));
  checks.push(sizeCheck("sidecar WAL size", `${opts.sidecarPath}-wal`, LARGE_WAL_BYTES));
  checks.push(staleBackfillJobsCheck(opts.sidecarPath));

  const summary = summarize(checks);
  return {
    status: summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass",
    worktree: opts.worktree,
    sidecarPath: opts.sidecarPath,
    checks,
    summary,
  };
}

export function formatEngramHealthReport(report: EngramHealthReport): string {
  return (
    [
      `status=${report.status}`,
      `worktree=${report.worktree}`,
      `sidecar=${report.sidecarPath}`,
      ...report.checks.map((check) => `${check.status}\t${check.name}\t${check.message}`),
      `${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.skip} skip`,
    ].join("\n") + "\n"
  );
}

function sidecarHealthCheck(path: string): EngramHealthCheck {
  const health = checkSidecarHealth(path);
  if (health.ok) return { name: "sidecar quick_check", status: "pass", message: "ok" };
  if (health.error.startsWith("Sidecar does not exist:")) {
    return { name: "sidecar quick_check", status: "warn", message: health.error };
  }
  return { name: "sidecar quick_check", status: "fail", message: health.error };
}

function sizeCheck(name: string, path: string, warnBytes: number): EngramHealthCheck {
  if (!existsSync(path)) return { name, status: "skip", message: `not found: ${path}` };
  const bytes = statSync(path).size;
  return {
    name,
    status: bytes > warnBytes ? "warn" : "pass",
    message: `${formatBytes(bytes)} at ${path}`,
    details: { bytes, warnBytes },
  };
}

function staleBackfillJobsCheck(path: string): EngramHealthCheck {
  if (!existsSync(path)) return { name: "stale backfill jobs", status: "skip", message: "sidecar not found" };
  try {
    const db = new Database(path, { readonly: true });
    applyConnPragmas(db);
    const stale = countStaleBackfillJobs(db);
    db.close();
    return {
      name: "stale backfill jobs",
      status: stale > 0 ? "warn" : "pass",
      message: stale > 0 ? `${stale} running backfill job lease(s) have expired` : "none",
      details: { stale },
    };
  } catch (error) {
    return {
      name: "stale backfill jobs",
      status: "warn",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarize(checks: EngramHealthCheck[]): Record<EngramHealthStatus, number> {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 } satisfies Record<EngramHealthStatus, number>,
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
