import { existsSync, statSync } from "node:fs";
import type { EngramConfig } from "./config.ts";
import { checkSidecarHealth } from "./db.ts";

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
  checks.push(sidecarHealthCheck(opts.sidecarPath));
  checks.push(sizeCheck("sidecar size", opts.sidecarPath, LARGE_DB_BYTES));
  checks.push(sizeCheck("sidecar WAL size", `${opts.sidecarPath}-wal`, LARGE_WAL_BYTES));

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
