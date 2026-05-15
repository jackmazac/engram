import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeFleetContext } from "@mazac-fox/opencode-fleet-contracts";
import EngramPlugin from "../src/index.ts";
import { insertChunkCorrelation } from "../src/db.ts";
import { getRuntime } from "../src/runtime.ts";

describe("EngramPlugin", () => {
  test("exports hook keys only", async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), "engram-pc-"));
    const hooks = await EngramPlugin({
      client: {} as never,
      project: { id: "p" } as never,
      directory: wt,
      worktree: wt,
      serverUrl: new URL("http://localhost"),
      experimental_workspace: { register: () => {} },
      $: {} as never,
    });
    const k = Object.keys(hooks);
    expect(
      k.every((x) =>
        ["event", "tool.execute.after", "experimental.chat.system.transform", "tool"].includes(x),
      ),
    ).toBe(true);
    expect(typeof hooks.tool?.memory?.execute).toBe("function");
    expect(typeof hooks.tool?.memory_context?.execute).toBe("function");
    expect(typeof hooks.tool?.memory_feedback?.execute).toBe("function");
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "conflict_context",
      "forget",
      "lifecycle_ingest",
      "memory",
      "memory_context",
      "memory_feedback",
      "stats",
    ]);
  });

  test("memory_context consumes fleet IDs from tool context", async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), "engram-pc-corr-"));
    const input = {
      client: {} as never,
      project: { id: "p" } as never,
      directory: wt,
      worktree: wt,
      serverUrl: new URL("http://localhost"),
      experimental_workspace: { register: () => {} },
      $: {} as never,
    };
    const hooks = await EngramPlugin(input);
    const runtime = await getRuntime(input).ready();
    if (!runtime) throw new Error("runtime did not start");
    runtime.db
      .prepare(
        `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "ctx-corr",
        "s",
        "m",
        null,
        "p",
        "assistant",
        null,
        null,
        "analysis",
        "Host supplied fleet context evidence.",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        Date.now(),
        "ctx-corr-hash",
        "s",
        0,
        "fleet-context",
        "lifecycle",
        "fixture:ctx-corr",
        8,
      );
    const decoded = decodeFleetContext({ correlation_id: "corr_01HY0000000000000000000000" });
    if (!decoded.ok) throw new Error(decoded.errors.join("; "));
    insertChunkCorrelation(runtime.db, { chunk_id: "ctx-corr", correlation: decoded.value });

    const output = await hooks.tool?.memory_context?.execute(
      { query: "unrelated words", mode: "plan", limit: 5 },
      {
        sessionID: "s",
        metadata: { fleet: { correlation_id: "corr_01HY0000000000000000000000" } },
      } as never,
    );
    expect(String(output)).toContain("Host supplied fleet context evidence");
    runtime.close();
  });
});
