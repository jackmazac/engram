import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEngramConfig } from "../src/config.ts";
import { createBackfillJob, leaseBackfillJob, openMemoryDb } from "../src/db.ts";
import { buildEngramHealthReport } from "../src/health.ts";

describe("Engram health report", () => {
  test("warns when runtime auto backfill is enabled", () => {
    const report = buildEngramHealthReport({
      cfg: {
        ...defaultEngramConfig,
        backfill: {
          ...defaultEngramConfig.backfill,
          auto: true,
        },
      },
      worktree: "/tmp/engram-health",
      sidecarPath: "/tmp/engram-health/memory.db",
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "runtime auto backfill",
        status: "warn",
      }),
    );
  });

  test("warns when a backfill job lease is stale", () => {
    const dir = path.join(os.tmpdir(), `engram-health-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const sidecarPath = path.join(dir, "memory.db");
    const db = openMemoryDb(sidecarPath);
    const job = createBackfillJob(db, {
      projectId: "p1",
      kind: "hot",
      strategy: "priority",
      now: 100,
    });
    leaseBackfillJob(db, { jobId: job.id, leaseOwner: "worker", leaseMs: 100, now: 200 });
    db.close();

    const report = buildEngramHealthReport({
      cfg: defaultEngramConfig,
      worktree: dir,
      sidecarPath,
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "stale backfill jobs",
        status: "warn",
      }),
    );

    rmSync(dir, { recursive: true, force: true });
  });
});
