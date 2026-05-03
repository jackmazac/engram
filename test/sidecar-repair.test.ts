import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkSidecarHealth, openMemoryDb, repairSidecar } from "../src/db.ts"

describe("sidecar repair", () => {
  test("reports healthy sidecars", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "engram-sidecar-health-"))
    const memoryPath = path.join(dir, "memory.db")
    const db = openMemoryDb(memoryPath)
    db.close()

    expect(checkSidecarHealth(memoryPath)).toEqual({ ok: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test("dry-run repair leaves sidecar files untouched", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "engram-sidecar-dry-run-"))
    const memoryPath = path.join(dir, "memory.db")
    const db = openMemoryDb(memoryPath)
    db.close()
    writeFileSync(`${memoryPath}-wal`, "wal")
    writeFileSync(`${memoryPath}-shm`, "shm")

    const result = repairSidecar({ path: memoryPath, dryRun: true })

    expect(result.repaired).toBe(false)
    expect(result.files.map((file) => path.basename(file)).sort()).toEqual(["memory.db", "memory.db-shm", "memory.db-wal"])
    expect(readFileSync(`${memoryPath}-wal`, "utf8")).toBe("wal")
    expect(readFileSync(`${memoryPath}-shm`, "utf8")).toBe("shm")
    expect(existsSync(memoryPath)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("apply repair quarantines sidecar files and recreates a usable db", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "engram-sidecar-repair-"))
    const memoryPath = path.join(dir, "memory.db")
    const db = openMemoryDb(memoryPath)
    db.close()
    writeFileSync(`${memoryPath}-wal`, "wal")
    writeFileSync(`${memoryPath}-shm`, "shm")

    const result = repairSidecar({ path: memoryPath, dryRun: false })
    const replacement = openMemoryDb(memoryPath)
    replacement.close()

    expect(result.repaired).toBe(true)
    expect(existsSync(path.join(result.quarantineDir, "memory.db"))).toBe(true)
    expect(existsSync(path.join(result.quarantineDir, "memory.db-wal"))).toBe(true)
    expect(existsSync(path.join(result.quarantineDir, "memory.db-shm"))).toBe(true)
    expect(checkSidecarHealth(memoryPath)).toEqual({ ok: true })
    rmSync(dir, { recursive: true, force: true })
  })

  test("cli repair-sidecar defaults to dry-run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "engram-sidecar-cli-"))
    const memoryPath = path.join(dir, ".opencode", "memory.db")
    mkdirSync(path.dirname(memoryPath), { recursive: true })
    const db = openMemoryDb(memoryPath)
    db.close()

    const proc = Bun.spawn(["bun", "run", "./src/cli/run.ts", "repair-sidecar", "--worktree", dir], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("dry_run=true")
    expect(stdout).toContain("memory.db")
    expect(existsSync(memoryPath)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
