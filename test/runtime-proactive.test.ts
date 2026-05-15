import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEngramConfig } from "../src/config.ts";
import { buildContextBundle } from "../src/context.ts";
import { openMemoryDb } from "../src/db.ts";
import { buildProactiveMemoryBlock, EngramRuntime, EngramRuntimeHandle } from "../src/runtime.ts";

describe("proactive memory injection", () => {
  test("skips memory block when retrieval hits a SQLite operational failure", async () => {
    const logged: unknown[] = [];

    const block = await buildProactiveMemoryBlock({
      seed: "why does opencode crash",
      maxChunks: 5,
      maxTokens: 2000,
      search: async () => {
        throw new Error("SQLiteError: disk I/O error");
      },
      onOperationalFailure: (error) => {
        logged.push(error);
      },
    });

    expect(block).toBeNull();
    expect(logged).toHaveLength(1);
  });

  test("rethrows non-operational retrieval failures", async () => {
    await expect(
      buildProactiveMemoryBlock({
        seed: "why does opencode crash",
        maxChunks: 5,
        maxTokens: 2000,
        search: async () => {
          throw new Error("programming bug");
        },
        onOperationalFailure: () => {},
      }),
    ).rejects.toThrow("programming bug");
  });

  test("context suggestions are off by default and opt-in", () => {
    const dir = path.join(os.tmpdir(), `engram-passive-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const db = openMemoryDb(path.join(dir, "memory.db"));
    const passive = buildContextBundle({ db, projectId: "p", query: "anything", limit: 5 });
    const active = buildContextBundle({
      db,
      projectId: "p",
      query: "anything",
      limit: 5,
      proactiveHintsEnabled: true,
    });
    expect(passive.suggestedNextSteps).toBeUndefined();
    expect(active.suggestedNextSteps?.length).toBeGreaterThan(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ambient runtime hooks swallow plugin failures", () => {
    const handle = new EngramRuntimeHandle(pluginInput("hook-failures"), {
      ...defaultEngramConfig,
      enabled: false,
    });
    (handle as never as { runtime: unknown; state: string }).runtime = {
      onMessageUpdated: () => {
        throw new Error("boom");
      },
      onPartUpdated: () => {
        throw new Error("boom");
      },
      onToolAfter: () => {
        throw new Error("boom");
      },
      onSessionIdle: () => {
        throw new Error("boom");
      },
      runtimeQueueStats: () => ({ pendingRows: 0, droppedRows: 0 }),
    };
    (handle as never as { state: string }).state = "ready";

    expect(() =>
      handle.onMessageUpdated({ properties: { info: { role: "assistant" } } }),
    ).not.toThrow();
    expect(() => handle.onPartUpdated({ properties: { part: { sessionID: "s" } } })).not.toThrow();
    expect(() => handle.onToolAfter("tool", "s", "output")).not.toThrow();
    expect(() => handle.onSessionIdle({ properties: { sessionID: "s" } })).not.toThrow();
  });

  test("ambient async hook work catches delayed failures", async () => {
    const worktree = path.join(os.tmpdir(), `engram-async-hooks-${Date.now()}`);
    const runtime = new EngramRuntime(pluginInputWithWorktree(worktree, "async-hooks"), {
      ...defaultEngramConfig,
      archive: {
        ...defaultEngramConfig.archive,
        autoCaptureBefore: true,
      },
    });
    const internals = runtime as unknown as {
      lastRetrieval: Map<string, { ids: string[]; logId: string }>;
      feedbackHook: (sessionID: string, tool: string, output: string) => void;
      maybeArchive: (sessionID: string | undefined) => Promise<void>;
    };
    internals.lastRetrieval.set("s", { ids: ["chunk123456789"], logId: "log" });
    internals.feedbackHook = () => {
      throw new Error("feedback failed");
    };
    internals.maybeArchive = async () => {
      throw new Error("archive failed");
    };

    runtime.onToolAfter("tool", "s", "chunk123456789");
    runtime.onSessionIdle({ properties: { sessionID: "s" } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    runtime.close();
    rmSync(worktree, { recursive: true, force: true });
  });

  test("system transform uses a shadow copy and deadline", async () => {
    const handle = new EngramRuntimeHandle(pluginInput("deadline"), {
      ...defaultEngramConfig,
      enabled: false,
      runtime: {
        ...defaultEngramConfig.runtime,
        systemTransformDeadlineMs: 5,
      },
    });
    (handle as never as { runtime: unknown; state: string }).runtime = {
      injectSystem: async (_sessionID: string | undefined, system: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        system.push("late mutation");
      },
      runtimeQueueStats: () => ({ pendingRows: 0, droppedRows: 0 }),
    };
    (handle as never as { state: string }).state = "ready";

    const system = ["base"];
    await handle.injectSystem("s", system);
    expect(system).toEqual(["base"]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(system).toEqual(["base"]);
  });
});

function pluginInput(projectId: string): never {
  const worktree = path.join(os.tmpdir(), `engram-runtime-${projectId}-${Date.now()}`);
  return pluginInputWithWorktree(worktree, projectId);
}

function pluginInputWithWorktree(worktree: string, projectId: string): never {
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
  } as never;
}
