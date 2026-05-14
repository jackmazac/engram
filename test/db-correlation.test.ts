import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeFleetContext } from "@mazac-fox/opencode-fleet-contracts";
import {
  insertChunkCorrelation,
  migrateMemoryDb,
  openMemoryDb,
  queryChunksByCorrelation,
  readChunkCorrelation,
} from "../src/db.ts";
import { Database } from "bun:sqlite";

describe("chunk correlation sidecar", () => {
  test("old sidecars migrate idempotently", () => {
    const dir = mkdirTemp("engram-corr-old-");
    const file = path.join(dir, "memory.db");
    const db = openMemoryDb(file);
    db.exec(`DROP TABLE chunk_correlation; PRAGMA user_version = 12;`);
    db.close();

    const migrated = openMemoryDb(file);
    migrateMemoryDb(migrated);
    expect(tableExists(migrated, "chunk_correlation")).toBe(true);
    expect(indexCount(migrated)).toBe(9);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("insert, read, and query by each indexed field", () => {
    const dir = mkdirTemp("engram-corr-");
    const db = openMemoryDb(path.join(dir, "memory.db"));
    insertChunk(db, "chunk-a");
    const decoded = decodeFleetContext({
      workspace_id: "ws_0123456789abcdef",
      plan_id: "pln_01HY0000000000000000000000",
      wave_id: "W3",
      agent_run_id: "run_01HY0000000000000000000000",
      correlation_id: "corr_01HY0000000000000000000000",
      tool_call_id: "tool_01HY0000000000000000000000",
      spine_seq: 42,
      artifact_ref:
        "artifact:plan:.opencode%2Fplans%2Ffleet.md:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lifecycle_object_id: "source-file:src/db.ts",
    });
    if (!decoded.ok) throw new Error(decoded.errors.join("; "));
    insertChunkCorrelation(db, { chunk_id: "chunk-a", correlation: decoded.value });

    expect(readChunkCorrelation(db, "chunk-a")?.correlation_id).toBe(
      "corr_01HY0000000000000000000000",
    );
    expect(queryChunksByCorrelation(db, { workspace_id: "ws_0123456789abcdef" })).toEqual([
      "chunk-a",
    ]);
    expect(queryChunksByCorrelation(db, { plan_id: "pln_01HY0000000000000000000000" })).toEqual([
      "chunk-a",
    ]);
    expect(queryChunksByCorrelation(db, { wave_id: "W3" })).toEqual(["chunk-a"]);
    expect(
      queryChunksByCorrelation(db, { agent_run_id: "run_01HY0000000000000000000000" }),
    ).toEqual(["chunk-a"]);
    expect(
      queryChunksByCorrelation(db, { correlation_id: "corr_01HY0000000000000000000000" }),
    ).toEqual(["chunk-a"]);
    expect(
      queryChunksByCorrelation(db, { tool_call_id: "tool_01HY0000000000000000000000" }),
    ).toEqual(["chunk-a"]);
    expect(queryChunksByCorrelation(db, { spine_seq: 42 })).toEqual(["chunk-a"]);
    expect(
      queryChunksByCorrelation(db, {
        artifact_ref:
          "artifact:plan:.opencode%2Fplans%2Ffleet.md:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toEqual(["chunk-a"]);
    expect(queryChunksByCorrelation(db, { lifecycle_object_id: "source-file:src/db.ts" })).toEqual([
      "chunk-a",
    ]);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

function mkdirTemp(prefix: string): string {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function insertChunk(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "s",
    "m",
    null,
    "p",
    "assistant",
    null,
    null,
    "plan",
    "correlated",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    Date.now(),
    "h",
    "s",
    0,
    null,
  );
}

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== null
  );
}

function indexCount(db: Database): number {
  const row = db
    .prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_cc_%'`)
    .get();
  if (!isRecord(row)) return 0;
  const value = row.c;
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
