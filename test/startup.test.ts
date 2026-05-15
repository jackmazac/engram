import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEngramConfig } from "../src/config.ts";
import { openMemoryDb, openMemoryDbLive } from "../src/db.ts";
import { EngramPlugin } from "../src/index.ts";
import { EngramRuntime, getRuntime } from "../src/runtime.ts";

describe("startup defaults", () => {
  test("hot DB backfill is opt-in so plugin runtime cannot scan large OpenCode databases by default", () => {
    expect(defaultEngramConfig.backfill.enabled).toBe(true);
    expect(defaultEngramConfig.backfill.auto).toBe(false);
    expect(defaultEngramConfig.backfill.repeat).toBe(false);
    expect(defaultEngramConfig.backfill.startupDelayMs).toBeGreaterThanOrEqual(30_000);
  });

  test("runtime construction with default config does not schedule a backfill event", () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-startup-"));
    mkdirSync(path.join(worktree, ".opencode"), { recursive: true });
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
    );

    const backfillEvents = runtime.db
      .query(`SELECT count(*) AS n FROM log_event WHERE category = ?`)
      .get("backfill");

    expect(backfillEvents).toEqual({ n: 0 });

    runtime.close();
    rmSync(worktree, { recursive: true, force: true });
  });

  test("plugin load does not synchronously open or migrate the sidecar", async () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-lazy-start-"));
    mkdirSync(path.join(worktree, ".opencode"), { recursive: true });
    const input = pluginInput(worktree, "lazy-start");

    const hooks = await EngramPlugin(input);

    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks.tool?.stats?.execute).toBe("function");
    expect(existsSync(path.join(worktree, ".opencode", "memory.db"))).toBe(false);
    getRuntime(input).close();
    rmSync(worktree, { recursive: true, force: true });
  });

  test("plugin load and hooks are fail-soft when sidecar startup fails", async () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-fail-soft-"));
    mkdirSync(path.join(worktree, ".opencode", "memory.db"), { recursive: true });
    writeFileSync(
      path.join(worktree, ".opencode", "engram.json"),
      `${JSON.stringify({ sidecar: { path: ".opencode/memory.db" } })}\n`,
    );
    const input = pluginInput(worktree, "fail-soft");
    const hooks = await EngramPlugin(input);

    await expect(
      hooks.event?.({
        event: {
          type: "message.updated",
          properties: { info: { role: "assistant", sessionID: "s" } },
        },
      } as never),
    ).resolves.toBeUndefined();
    const stats = await hooks.tool?.stats?.execute({ report: "overview" }, {
      sessionID: "s",
    } as never);
    expect(String(stats)).toContain("Engram: degraded");
    const conflict = (await hooks.tool?.conflict_context?.execute({ query: "anything" }, {
      sessionID: "s",
    } as never)) as { metadata?: Record<string, unknown> } | undefined;
    expect(conflict?.metadata?.suggestedNextSteps).toBeUndefined();

    getRuntime(input).close();
    rmSync(worktree, { recursive: true, force: true });
  });

  test("live sidecar connections use a shorter busy timeout than maintenance connections", () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-live-timeout-"));
    const live = openMemoryDbLive(path.join(worktree, "live.db"));
    const maintenance = openMemoryDb(path.join(worktree, "maintenance.db"));
    expect(busyTimeout(live)).toBeLessThan(busyTimeout(maintenance));
    live.close();
    maintenance.close();
    rmSync(worktree, { recursive: true, force: true });
  });
});

function pluginInput(worktree: string, projectId: string): never {
  return {
    client: {
      session: {
        get: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    },
    project: { id: projectId },
    directory: worktree,
    worktree,
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
    $: {} as never,
  } as never;
}

function busyTimeout(db: ReturnType<typeof openMemoryDb>): number {
  const row = db.query("PRAGMA busy_timeout;").get() as Record<string, number>;
  return Object.values(row)[0] ?? 0;
}
