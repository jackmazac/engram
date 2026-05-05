import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEngramConfig } from "../src/config.ts";
import { openMemoryDb } from "../src/db.ts";
import { searchMemory } from "../src/retrieve.ts";

function embedding(value: number, dimensions: number): Buffer {
  const vector = new Float32Array(dimensions);
  vector[0] = value;
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

describe("retrieval budgets", () => {
  test("broad vector search caps candidate scan count", async () => {
    const dir = path.join(os.tmpdir(), `engram-retrieval-budget-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const db = openMemoryDb(path.join(dir, "memory.db"));
    const cfg = {
      ...defaultEngramConfig,
      memorySearch: {
        ...defaultEngramConfig.memorySearch,
        maxVectorCandidates: 1,
      },
    };
    const insert = db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        embedding, time_created, time_embedded, content_hash, root_session_id, session_depth,
        plan_slug, embedding_model, embedding_dimensions
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    for (let i = 0; i < 3; i += 1) {
      insert.run(
        `chunk-${i}`,
        `session-${i}`,
        `message-${i}`,
        null,
        "p1",
        "assistant",
        null,
        null,
        "decision",
        `budget memory ${i}`,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        embedding(i + 1, cfg.sidecar.dimensions),
        i + 1,
        i + 1,
        `hash-${i}`,
        "root",
        0,
        null,
        cfg.embed.model,
        cfg.sidecar.dimensions,
      );
    }

    const result = await searchMemory({
      db,
      cfg,
      projectId: "p1",
      query: "budget memory",
      scope: "broad",
      limit: 3,
      skipRerank: true,
      queryEmbedding: [1, ...Array.from({ length: cfg.sidecar.dimensions - 1 }, () => 0)],
    });

    expect(result.metrics.vecCandidates).toBe(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
