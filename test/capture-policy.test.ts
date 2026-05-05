import { describe, expect, test } from "bun:test"
import { defaultEngramConfig } from "../src/config.ts"
import { fromPart } from "../src/capture.ts"

const ctx = { agent: "executor", model: "model" }

describe("capture policy", () => {
  test("skips completed denied tool output by default", () => {
    const rows = fromPart(
      {
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        tool: "read",
        state: { status: "completed", output: "large file body" },
      },
      "project",
      defaultEngramConfig,
      null,
      ctx,
    )
    expect(rows).toHaveLength(0)
  })

  test("captures bounded error output even for denied tools", () => {
    const rows = fromPart(
      {
        id: "p2",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        tool: "read",
        state: { status: "error", error: "x".repeat(20_000) },
      },
      "project",
      defaultEngramConfig,
      null,
      ctx,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.output_length).toBe(10_000)
    expect(rows[0]?.error_class).toBe("tool_error")
  })

  test("skips DCP compression banner text", () => {
    const rows = fromPart(
      {
        id: "p3",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "▣ DCP | -105.9K removed, +2.7K summary\n\n│██⣿⣿⣿████│\n▣ Compression #1 -105.9K removed, +2.7K summary",
      },
      "project",
      defaultEngramConfig,
      null,
      ctx,
    )
    expect(rows).toHaveLength(0)
  })

  test("skips subagent task assignment boilerplate", () => {
    const rows = fromPart(
      {
        id: "p4",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "Plan: full-project-hygiene | Task: ZA-WC1-F2 | Wave: ZA-WC — close remaining contracts\n\nFirst load plan. Implement work queue remaining task-kind contracts.",
      },
      "project",
      defaultEngramConfig,
      null,
      { agent: "executor-high", model: "model" },
    )
    expect(rows).toHaveLength(0)
  })
})
