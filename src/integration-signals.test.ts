import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSources } from "./artifacts.ts";
import { contextBundleRequestSchema } from "./bridge-contract.ts";
import { loadConfig } from "./config.ts";

describe("integration signals", () => {
  test("discovers lifecycle and Concord artifacts without double-counting Concord as generic lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "engram-lifecycle-artifacts-"));
    try {
      const lifecycle = join(root, ".opencode", "lifecycle", "artifacts");
      const concord = join(lifecycle, "concord");
      await mkdir(concord, { recursive: true });
      await writeFile(
        join(lifecycle, "decision.json"),
        JSON.stringify({ kind: "lifecycle", event_id: "life_1" }),
      );
      await writeFile(
        join(concord, "42.json"),
        JSON.stringify({ event_id: "42", file_path: "src/a.ts" }),
      );
      await writeFile(join(concord, "42.xml"), '<concord_conflict version="1" />');

      const sources = discoverSources(root, loadConfig(root));

      expect(
        sources.some(
          (source) => source.kind === "lifecycle" && source.rel.endsWith("decision.json"),
        ),
      ).toBe(true);
      expect(
        sources.some(
          (source) => source.kind === "concord_collision" && source.rel.endsWith("42.json"),
        ),
      ).toBe(true);
      expect(
        sources.some(
          (source) => source.kind === "concord_guidance" && source.rel.endsWith("42.xml"),
        ),
      ).toBe(true);
      expect(
        sources.filter((source) => source.rel.endsWith("42.json")).map((source) => source.kind),
      ).toEqual(["concord_collision"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts correlation-aware context bundle signals", () => {
    const parsed = contextBundleRequestSchema.parse({
      projectId: "project_1",
      query: "conflict context",
      workspaceSignals: {
        changedFiles: ["src/a.ts"],
        correlationId: "corr_123",
        planSlug: "fleet-integration",
        waveId: "wave-1",
        agentRunId: "run_123",
        lifecycleObjectIds: ["source-file:src/a.ts"],
        artifactRefs: ["artifact:concord:42"],
        concordEventIds: ["42"],
      },
    });

    expect(parsed.workspaceSignals?.correlationId).toBe("corr_123");
    expect(parsed.workspaceSignals?.concordEventIds).toEqual(["42"]);
  });
});
