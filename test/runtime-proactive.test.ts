import { describe, expect, test } from "bun:test"
import { buildProactiveMemoryBlock } from "../src/runtime.ts"

describe("proactive memory injection", () => {
  test("skips memory block when retrieval hits a SQLite operational failure", async () => {
    const logged: unknown[] = []

    const block = await buildProactiveMemoryBlock({
      seed: "why does opencode crash",
      maxChunks: 5,
      maxTokens: 2000,
      search: async () => {
        throw new Error("SQLiteError: disk I/O error")
      },
      onOperationalFailure: (error) => {
        logged.push(error)
      },
    })

    expect(block).toBeNull()
    expect(logged).toHaveLength(1)
  })

  test("rethrows non-operational retrieval failures", async () => {
    await expect(
      buildProactiveMemoryBlock({
        seed: "why does opencode crash",
        maxChunks: 5,
        maxTokens: 2000,
        search: async () => {
          throw new Error("programming bug")
        },
        onOperationalFailure: () => {},
      }),
    ).rejects.toThrow("programming bug")
  })
})
