import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultEngramConfig } from "../src/config.ts"
import { discoverSources } from "../src/artifacts.ts"

describe("artifact path security", () => {
  test("rejects configured paths that escape the worktree", () => {
    const dir = makeDir("engram-artifact-escape-")
    const cfg = {
      ...defaultEngramConfig,
      integration: {
        ...defaultEngramConfig.integration,
        artifactPaths: {
          ...defaultEngramConfig.integration.artifactPaths,
          plans: "../outside",
        },
      },
    }
    expect(() => discoverSources(dir, cfg)).toThrow("Artifact path escapes worktree")
    rmSync(dir, { recursive: true, force: true })
  })

  test("rejects absolute paths outside the worktree", () => {
    const dir = makeDir("engram-artifact-absolute-")
    const outside = makeDir("engram-artifact-outside-")
    const cfg = {
      ...defaultEngramConfig,
      integration: {
        ...defaultEngramConfig.integration,
        artifactPaths: {
          ...defaultEngramConfig.integration.artifactPaths,
          plans: outside,
        },
      },
    }
    expect(() => discoverSources(dir, cfg)).toThrow("Artifact path escapes worktree")
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test("rejects symlinked artifact files that escape the worktree", () => {
    const dir = makeDir("engram-artifact-symlink-")
    const outside = makeDir("engram-artifact-symlink-outside-")
    mkdirSync(path.join(dir, ".opencode", "plans"), { recursive: true })
    const outsidePlan = path.join(outside, "plan.md")
    writeFileSync(outsidePlan, "# Outside\n")
    symlinkSync(outsidePlan, path.join(dir, ".opencode", "plans", "outside.md"))
    expect(() => discoverSources(dir, defaultEngramConfig)).toThrow("Artifact path escapes worktree")
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
})

function makeDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
