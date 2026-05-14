import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArtifactRef, decodeFleetContext } from "@mazac-fox/opencode-fleet-contracts";
import { buildContextBundle, formatContextBundle } from "../src/context.ts";
import { insertChunkCorrelation, openMemoryDb } from "../src/db.ts";

describe("correlation-aware context", () => {
  test("conflict_context path boosts chunks matched by fleet IDs", () => {
    const dir = path.join(os.tmpdir(), `engram-context-corr-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const db = openMemoryDb(path.join(dir, "memory.db"));
    db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "corr-chunk",
      "s",
      "m",
      null,
      "p",
      "assistant",
      null,
      null,
      "analysis",
      "Concurrency collision evidence that does not share query tokens.",
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
      "fleet-correlation",
      "lifecycle",
      "artifact:lifecycle:collision.json:abc",
      8,
    );
    const decoded = decodeFleetContext({ correlation_id: "corr_01HY0000000000000000000000" });
    if (!decoded.ok) throw new Error(decoded.errors.join("; "));
    insertChunkCorrelation(db, { chunk_id: "corr-chunk", correlation: decoded.value });

    const bundle = buildContextBundle({
      db,
      projectId: "p",
      query: "unrelated retry",
      mode: "debug",
      limit: 5,
      workspaceSignals: { correlationId: "corr_01HY0000000000000000000000" },
    });

    expect(formatContextBundle(bundle)).toContain("Concurrency collision evidence");
    expect(JSON.stringify(bundle)).not.toContain("suggestedNextSteps");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("queries every repeated artifact ref instead of only the first", () => {
    const dir = path.join(os.tmpdir(), `engram-context-corr-many-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const db = openMemoryDb(path.join(dir, "memory.db"));
    const refA = buildArtifactRef({ kind: "plan", path: "a.md", hash: "a".repeat(64) }).ref;
    const refB = buildArtifactRef({ kind: "plan", path: "b.md", hash: "b".repeat(64) }).ref;
    insertChunk(db, "chunk-a", "First artifact evidence.");
    insertChunk(db, "chunk-b", "Second artifact evidence.");
    const a = decodeFleetContext({ artifact_ref: refA });
    const b = decodeFleetContext({ artifact_ref: refB });
    if (!a.ok || !b.ok) throw new Error("bad refs");
    insertChunkCorrelation(db, { chunk_id: "chunk-a", correlation: a.value });
    insertChunkCorrelation(db, { chunk_id: "chunk-b", correlation: b.value });

    const bundle = buildContextBundle({
      db,
      projectId: "p",
      query: "unrelated",
      mode: "plan",
      limit: 5,
      workspaceSignals: { artifactRefs: [refA, refB] },
    });
    const text = formatContextBundle(bundle);
    expect(text).toContain("First artifact evidence");
    expect(text).toContain("Second artifact evidence");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

function insertChunk(db: ReturnType<typeof openMemoryDb>, id: string, content: string) {
  db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "s",
    `${id}-message`,
    null,
    "p",
    "assistant",
    null,
    null,
    "analysis",
    content,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    Date.now(),
    `${id}-hash`,
    "s",
    0,
    "fleet-correlation",
    "lifecycle",
    `artifact:${id}`,
    8,
  );
}
