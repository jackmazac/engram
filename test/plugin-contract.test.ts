import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import EngramPlugin from "../src/index.ts";

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
});
