import { describe, expect, test } from "bun:test";
import { defaultEngramConfig } from "../src/config.ts";
import { withTimeout } from "../src/openai.ts";

describe("OpenAI safety helpers", () => {
  test("classification has a lower-priority per-drain budget", () => {
    expect(defaultEngramConfig.classify.maxRowsPerDrain).toBe(25);
  });

  test("withTimeout rejects slow operations with an actionable label", async () => {
    await expect(
      withTimeout(new Promise((resolve) => setTimeout(() => resolve("late"), 20)), 1, "embed"),
    ).rejects.toThrow("embed timed out after 1ms");
  });

  test("withTimeout returns fast operation results", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "embed")).resolves.toBe("ok");
  });
});
