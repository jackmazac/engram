import { describe, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin/tool";
import type { ToolDefinition } from "@opencode-ai/plugin/tool";
import { applyToolSurfaceBudget } from "../src/plugin-tool-budget.ts";

const z = tool.schema;

function measureAll(tools: Record<string, ToolDefinition>): number {
  let n = 0;
  for (const def of Object.values(tools)) {
    const schema = z.object(def.args);
    n += def.description.length + JSON.stringify(z.toJSONSchema(schema)).length;
  }
  return n;
}

describe("applyToolSurfaceBudget", () => {
  test("leaves tools unchanged when under budget", () => {
    const tools: Record<string, ToolDefinition> = {
      a: tool({
        description: "short",
        args: { x: z.string() },
        async execute() {
          return "ok";
        },
      }),
    };
    const out = applyToolSurfaceBudget(tools, 50_000);
    const a = out.a;
    expect(a).toBeDefined();
    if (a === undefined) throw new Error("missing tool");
    expect(a.description).toBe("short");
  });

  test("truncates descriptions to meet budget", () => {
    const pad = "x".repeat(5000);
    const tools: Record<string, ToolDefinition> = {
      a: tool({
        description: `${pad} tool a`,
        args: { q: z.string() },
        async execute() {
          return "ok";
        },
      }),
      b: tool({
        description: `${pad} tool b`,
        args: { q: z.string() },
        async execute() {
          return "ok";
        },
      }),
    };
    const out = applyToolSurfaceBudget(tools, 3000);
    const oa = out.a;
    const ob = out.b;
    expect(oa).toBeDefined();
    expect(ob).toBeDefined();
    if (oa === undefined || ob === undefined) throw new Error("missing tools");
    expect(oa.description.length).toBeLessThan(pad.length + 20);
    expect(oa.description.includes("truncated engram tools") || ob.description.includes("truncated engram tools")).toBe(
      true,
    );
    expect(measureAll(out)).toBeLessThanOrEqual(3000);
  });
});
