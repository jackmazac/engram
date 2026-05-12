import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { Database } from "bun:sqlite"
import { defaultEngramConfig } from "../src/config.ts"
import { applyConnPragmas, openMemoryDb } from "../src/db.ts"
import { importArchiveToMemory, restoreArchiveToHot } from "../src/archive.ts"

describe("archive trust boundaries", () => {
  test("restore rejects malformed JSONL with a clear error", async () => {
    const fixture = makeArchive("malformed", "not-json\n")
    await expect(
      restoreArchiveToHot({
        memoryDb: fixture.memory,
        archiveRoot: fixture.archiveRoot,
        hotPath: fixture.hotPath,
        projectId: "p1",
        rootSessionId: "root",
        dryRun: true,
      }),
    ).rejects.toThrow("Malformed archive JSONL")
    cleanup(fixture)
  })

  test("restore rejects out-of-scope project records", async () => {
    const fixture = makeArchive(
      "project-escape",
      `${JSON.stringify({
        kind: "session",
        id: "root",
        project_id: "other",
        parent_id: null,
        time_created: 1,
        time_updated: 2,
      })}\n`,
    )
    await expect(
      restoreArchiveToHot({
        memoryDb: fixture.memory,
        archiveRoot: fixture.archiveRoot,
        hotPath: fixture.hotPath,
        projectId: "p1",
        rootSessionId: "root",
        dryRun: true,
      }),
    ).rejects.toThrow("project mismatch")
    cleanup(fixture)
  })

  test("import streams large archives without materializing parts", async () => {
    const lines = [
      JSON.stringify({
        kind: "session",
        id: "root",
        project_id: "p1",
        parent_id: null,
        time_created: 1,
        time_updated: 2,
      }),
    ]
    for (let i = 0; i < 2000; i += 1) {
      lines.push(
        JSON.stringify({
          kind: "message",
          id: `m${i}`,
          session_id: "root",
          time_created: 10 + i,
          data: { role: "assistant", agent: "worker" },
        }),
      )
      lines.push(
        JSON.stringify({
          kind: "part",
          id: `p${i}`,
          message_id: `m${i}`,
          session_id: "root",
          time_created: 20 + i,
          data: { type: "text", text: `streamed memory ${i}` },
        }),
      )
    }
    const fixture = makeArchive("large", `${lines.join("\n")}\n`)
    const before = process.memoryUsage().heapUsed
    const result = await importArchiveToMemory({
      memoryDb: fixture.memory,
      archiveRoot: fixture.archiveRoot,
      projectId: "p1",
      rootSessionId: "root",
      cfg: defaultEngramConfig,
      dryRun: false,
    })
    const delta = process.memoryUsage().heapUsed - before
    expect(result.inserted).toBe(2000)
    expect(result.scannedParts).toBe(2000)
    expect(delta).toBeLessThan(64 * 1024 * 1024)
    cleanup(fixture)
  })
})

function makeArchive(name: string, jsonl: string) {
  const dir = path.join(os.tmpdir(), `engram-archive-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const archiveRoot = path.join(dir, "archives")
  mkdirSync(path.join(archiveRoot, "p1"), { recursive: true })
  const hotPath = path.join(dir, "hot.db")
  const hot = new Database(hotPath, { create: true })
  applyConnPragmas(hot)
  hot.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  hot.close()
  const memory = openMemoryDb(path.join(dir, "memory.db"))
  const archiveRel = path.join("p1", "root.jsonl.gz")
  writeFileSync(path.join(archiveRoot, archiveRel), gzipSync(jsonl))
  memory.prepare(
    `INSERT INTO archive (
      id, root_session_id, project_id, session_count, message_count, part_count,
      archive_path, archive_size, content_hash, time_created
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run("a1", "root", "p1", 1, 1, 1, archiveRel, 1, "unused", Date.now())
  return { dir, archiveRoot, hotPath, memory }
}

function cleanup(fixture: ReturnType<typeof makeArchive>) {
  fixture.memory.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}
