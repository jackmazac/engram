import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEngramConfig } from "../src/config.ts";
import {
  applyConnPragmas,
  cancelBackfillJob,
  createBackfillJob,
  finishBackfillJob,
  leaseBackfillJob,
  openMemoryDb,
  readBackfillJob,
  updateBackfillJobProgress,
} from "../src/db.ts";
import { backfillHot, runBackfillHotJob } from "../src/hot-backfill.ts";

describe("backfill job state", () => {
  test("tracks resumable progress, leases, cancellation, and terminal state", () => {
    const dir = path.join(os.tmpdir(), `engram-backfill-job-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const db = openMemoryDb(path.join(dir, "memory.db"));

    const job = createBackfillJob(db, {
      projectId: "p1",
      kind: "hot",
      strategy: "priority",
      cursor: { root: null, part: null },
      now: 100,
    });
    expect(job.status).toBe("pending");
    expect(job.cursor_json).toBe(JSON.stringify({ root: null, part: null }));

    const leased = leaseBackfillJob(db, {
      jobId: job.id,
      leaseOwner: "worker-1",
      leaseMs: 1_000,
      now: 200,
    });
    expect(leased?.status).toBe("running");
    expect(leased?.lease_owner).toBe("worker-1");
    expect(leased?.lease_expires_at).toBe(1_200);

    const progressed = updateBackfillJobProgress(db, {
      jobId: job.id,
      cursor: { root: "root-1", part: "part-9" },
      processedRoots: 1,
      processedParts: 9,
      insertedChunks: 3,
      now: 300,
    });
    expect(progressed?.cursor_json).toBe(JSON.stringify({ root: "root-1", part: "part-9" }));
    expect(progressed?.processed_roots).toBe(1);
    expect(progressed?.processed_parts).toBe(9);
    expect(progressed?.inserted_chunks).toBe(3);

    expect(cancelBackfillJob(db, { jobId: job.id, now: 400 })?.status).toBe("cancelled");
    expect(
      leaseBackfillJob(db, { jobId: job.id, leaseOwner: "worker-2", leaseMs: 1_000, now: 500 }),
    ).toBeNull();

    const completed = createBackfillJob(db, {
      projectId: "p1",
      kind: "hot",
      strategy: "errors",
      cursor: null,
      now: 600,
    });
    expect(
      finishBackfillJob(db, { jobId: completed.id, status: "completed", now: 700 })?.status,
    ).toBe("completed");
    expect(readBackfillJob(db, completed.id)?.time_finished).toBe(700);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("hot backfill job records durable completion state", () => {
    const dir = path.join(os.tmpdir(), `engram-hot-job-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const memory = openMemoryDb(path.join(dir, "memory.db"));
    const hotPath = path.join(dir, "hot.db");
    const hot = new Database(hotPath, { create: true });
    applyConnPragmas(hot);
    hot.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    hot
      .prepare(
        `INSERT INTO session (id, project_id, parent_id, title, time_created, time_updated) VALUES (?,?,?,?,?,?)`,
      )
      .run("root", "p1", null, "Root Backfill Job", 1, 2);
    hot
      .prepare(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`)
      .run("m1", "root", JSON.stringify({ role: "assistant", agent: "worker" }));
    hot
      .prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`,
      )
      .run("part-1", "m1", "root", 3, JSON.stringify({ type: "text", text: "job memory" }));
    hot.close();

    memory
      .prepare(
        `INSERT INTO session_root_index (
          id, project_id, root_session_id, title, time_created, time_updated, child_count,
          message_count, part_count, assistant_count, user_count, tool_count, patch_count,
          reasoning_count, primary_agents_json, priority_score, status, content_hash, indexed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "idx",
        "p1",
        "root",
        "Root Backfill Job",
        1,
        2,
        0,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        "[]",
        10,
        "indexed",
        "h",
        4,
      );

    const result = runBackfillHotJob({
      db: memory,
      hotPath,
      projectId: "p1",
      cfg: defaultEngramConfig,
      strategy: "priority",
      maxRoots: 1,
      maxParts: 10,
      leaseOwner: "test-worker",
      now: 10,
    });

    expect(result.summary.chunksInserted).toBe(1);
    expect(result.job.status).toBe("completed");
    expect(result.job.processed_roots).toBe(1);
    expect(result.job.processed_parts).toBe(1);
    expect(result.job.inserted_chunks).toBe(1);
    expect(result.job.time_finished).toBe(10);

    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("hot backfill job records failure and rethrows", () => {
    const dir = path.join(os.tmpdir(), `engram-hot-job-fail-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const memory = openMemoryDb(path.join(dir, "memory.db"));
    const hotPath = path.join(dir, "hot.db");
    const hot = new Database(hotPath, { create: true });
    applyConnPragmas(hot);
    hot.exec(`CREATE TABLE unrelated (id TEXT PRIMARY KEY);`);
    hot.close();

    memory
      .prepare(
        `INSERT INTO session_root_index (
          id, project_id, root_session_id, title, time_created, time_updated, child_count,
          message_count, part_count, assistant_count, user_count, tool_count, patch_count,
          reasoning_count, primary_agents_json, priority_score, status, content_hash, indexed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("idx", "p1", "root", "root", 1, 2, 0, 1, 1, 1, 0, 0, 0, 0, "[]", 10, "indexed", "h", 4);

    expect(() =>
      runBackfillHotJob({
        db: memory,
        hotPath,
        projectId: "p1",
        cfg: defaultEngramConfig,
        strategy: "priority",
        maxRoots: 1,
        maxParts: 10,
        leaseOwner: "test-worker",
        now: 10,
      }),
    ).toThrow();
    const row = memory
      .prepare(`SELECT status, error_summary FROM backfill_job WHERE project_id = ?`)
      .get("p1") as { status: string; error_summary: string | null };
    expect(row.status).toBe("failed");
    expect(row.error_summary).toBeTruthy();

    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("hot backfill honors max sessions per root before reading parts", () => {
    const dir = path.join(os.tmpdir(), `engram-hot-budget-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const memory = openMemoryDb(path.join(dir, "memory.db"));
    const hotPath = path.join(dir, "hot.db");
    const hot = new Database(hotPath, { create: true });
    applyConnPragmas(hot);
    hot.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const sessions: Array<[string, string | null]> = [
      ["root", null],
      ["child-1", "root"],
      ["child-2", "root"],
    ];
    for (const [id, parent] of sessions) {
      hot
        .prepare(
          `INSERT INTO session (id, project_id, parent_id, title, time_created, time_updated) VALUES (?,?,?,?,?,?)`,
        )
        .run(id, "p1", parent, id, 1, 2);
      hot
        .prepare(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`)
        .run(`m-${id}`, id, JSON.stringify({ role: "assistant", agent: "worker" }));
      hot
        .prepare(
          `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`,
        )
        .run(`p-${id}`, `m-${id}`, id, 3, JSON.stringify({ type: "text", text: `memory ${id}` }));
    }
    hot.close();

    memory
      .prepare(
        `INSERT INTO session_root_index (
          id, project_id, root_session_id, title, time_created, time_updated, child_count,
          message_count, part_count, assistant_count, user_count, tool_count, patch_count,
          reasoning_count, primary_agents_json, priority_score, status, content_hash, indexed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("idx", "p1", "root", "root", 1, 2, 2, 3, 3, 3, 0, 0, 0, 0, "[]", 10, "indexed", "h", 4);

    const summary = backfillHot({
      db: memory,
      hotPath,
      projectId: "p1",
      cfg: {
        ...defaultEngramConfig,
        backfill: {
          ...defaultEngramConfig.backfill,
          maxSessionsPerRoot: 1,
        },
      },
      strategy: "priority",
      dryRun: true,
      maxRoots: 1,
      maxParts: 10,
    });

    expect(summary.scannedParts).toBe(1);

    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
