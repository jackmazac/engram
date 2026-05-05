import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEngramConfig } from "../src/config.ts";
import { EngramRuntime } from "../src/runtime.ts";

function pluginInput(worktree: string) {
  return {
    client: {
      session: {
        get: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    },
    project: { id: "runtime-queue" },
    directory: worktree,
    worktree,
  };
}

function queuedPart(id: string) {
  return {
    properties: {
      part: {
        id,
        sessionID: "session-1",
        messageID: `message-${id}`,
        type: "text",
        text: `queued memory ${id}`,
        time: { created: Date.now() },
      },
    },
  };
}

describe("runtime write queue", () => {
  test("default runtime queue budgets are explicit and bounded", () => {
    expect(defaultEngramConfig.runtime.writeIntervalMs).toBe(500);
    expect(defaultEngramConfig.runtime.writeBatchSize).toBe(50);
    expect(defaultEngramConfig.runtime.writeQueueMax).toBe(500);
  });

  test("enqueue never flushes SQLite inline when queue capacity is reached", () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-runtime-queue-"));
    mkdirSync(path.join(worktree, ".opencode"), { recursive: true });
    const runtime = new EngramRuntime(pluginInput(worktree), {
      ...defaultEngramConfig,
      embed: {
        ...defaultEngramConfig.embed,
        queueMax: 1,
      },
      runtime: {
        ...defaultEngramConfig.runtime,
        writeQueueMax: 1,
      },
      backfill: {
        ...defaultEngramConfig.backfill,
        auto: false,
      },
    });

    try {
      runtime.onPartUpdated(queuedPart("one"));
      runtime.onPartUpdated(queuedPart("two"));

      const count = runtime.db
        .query(`SELECT count(*) AS n FROM chunk WHERE project_id = ?`)
        .get("runtime-queue");

      expect(count).toEqual({ n: 0 });
      expect(runtime.runtimeQueueStats()).toEqual({ pendingRows: 1, droppedRows: 1 });
    } finally {
      runtime.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
