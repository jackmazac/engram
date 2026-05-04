import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContextBundle } from "../src/context.ts";
import { openMemoryDb } from "../src/db.ts";
import { buildProactiveMemoryBlock } from "../src/runtime.ts";

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
});
