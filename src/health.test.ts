import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultEngramConfig } from "./config.ts";
import { buildEngramHealthReport, formatEngramHealthReport } from "./health.ts";

describe("Engram health report", () => {
  test("warns but does not fail when sidecar has not been created yet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "engram-health-"));
    try {
      const report = buildEngramHealthReport({
        cfg: defaultEngramConfig,
        worktree: root,
        sidecarPath: path.join(root, ".opencode", "memory.db"),
      });

      expect(report.status).toBe("warn");
      expect(report.summary.fail).toBe(0);
      expect(
        report.checks.some(
          (check) => check.name === "sidecar quick_check" && check.status === "warn",
        ),
      ).toBe(true);
      expect(formatEngramHealthReport(report)).toContain("sidecar quick_check");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
