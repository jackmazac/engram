#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import EngramPlugin from "../src/index.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const worktree = mkdtempSync(path.join(os.tmpdir(), "engram-runtime-smoke-"));
  mkdirSync(path.join(worktree, ".opencode", "plans"), { recursive: true });
  writeFileSync(
    path.join(worktree, ".opencode", "engram.json"),
    JSON.stringify({
      backfill: { enabled: false, auto: false },
      context: { proactiveHints: { enabled: false } },
    }),
  );
  writeFileSync(
    path.join(worktree, ".opencode", "plans", "smoke.md"),
    "# Runtime smoke\n\nKnown synthetic plan content for lifecycle ingest.",
  );

  const hooks = await EngramPlugin({
    client: {
      session: {
        get: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    },
    project: { id: "runtime-smoke" },
    directory: worktree,
    worktree,
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
    $: {},
  });

  const tools = hooks.tool;
  assert(tools, "plugin did not expose tools");
  const context = {
    sessionID: "smoke-session",
    metadata: { fleet: { correlation_id: "corr_01HY0000000000000000000000" } },
  };

  const memory = await tools.memory.execute({ query: "nothing yet" }, context);
  assert(
    String(memory).includes("No matching memories"),
    "memory did not return empty result on fresh DB",
  );

  const ingest = await tools.lifecycle_ingest.execute(
    { apply: true, worktree_root: worktree },
    context,
  );
  assert(
    typeof ingest === "object" && ingest !== null,
    "lifecycle_ingest did not return an object",
  );

  const memoryContext = await tools.memory_context.execute(
    { query: "Runtime smoke", mode: "plan" },
    context,
  );
  assert(
    String(memoryContext).includes("Engram preflight context"),
    "memory_context missing context header",
  );
  assert(
    !String(memoryContext).includes("suggestedNextSteps"),
    "memory_context leaked suggestedNextSteps",
  );

  const conflict = await tools.conflict_context.execute(
    { query: "Runtime smoke", correlation_id: "corr_01HY0000000000000000000000" },
    context,
  );
  assert(
    typeof conflict === "object" && conflict !== null,
    "conflict_context did not return structured output",
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
