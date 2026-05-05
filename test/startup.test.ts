import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultEngramConfig } from "../src/config.ts"
import { EngramRuntime } from "../src/runtime.ts"

describe("startup defaults", () => {
  test("hot DB backfill is opt-in so plugin runtime cannot scan large OpenCode databases by default", () => {
    expect(defaultEngramConfig.backfill.enabled).toBe(true)
    expect(defaultEngramConfig.backfill.auto).toBe(false)
    expect(defaultEngramConfig.backfill.repeat).toBe(false)
    expect(defaultEngramConfig.backfill.startupDelayMs).toBeGreaterThanOrEqual(30_000)
  })

  test("runtime construction with default config does not schedule a backfill event", () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-startup-"))
    mkdirSync(path.join(worktree, ".opencode"), { recursive: true })
    const runtime = new EngramRuntime(
      {
        client: {
          session: {
            get: async () => ({ data: {} }),
            messages: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
          },
        },
        project: { id: "startup-defaults" },
        directory: worktree,
        worktree,
      },
      defaultEngramConfig,
    )

    const backfillEvents = runtime.db
      .query(`SELECT count(*) AS n FROM log_event WHERE category = ?`)
      .get("backfill")

    expect(backfillEvents).toEqual({ n: 0 })

    runtime.close()
    rmSync(worktree, { recursive: true, force: true })
  })
})
