import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { openMemoryDb } from "../src/db.ts"

const cli = path.resolve("src/cli/run.ts")

describe("CLI safety defaults", () => {
  test("curate dry-run and telemetry reads leave sidecar rows unchanged", async () => {
    const dir = makeWorktree("engram-cli-safety-")
    const db = openMemoryDb(path.join(dir, ".opencode", "memory.db"))
    insertChunk(db, "c1", "duplicate content worth keeping", "same-hash")
    insertChunk(db, "c2", "duplicate content worth keeping", "same-hash")
    db.prepare(
      `INSERT INTO operation_metric (
        id, project_id, operation, status, duration_ms, rows_count, bytes_count,
        heap_used_delta, rss_delta, detail, time_created, workspace_id, correlation_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("m1", "p1", "memory.search", "ok", 1, 1, null, null, null, "{}", 1, null, null)
    db.close()

    await runCli(["curate", "--project-id", "p1", "--worktree", dir])
    await runCli(["telemetry", "--project-id", "p1", "--worktree", dir])

    const after = openMemoryDb(path.join(dir, ".opencode", "memory.db"))
    expect(count(after, "chunk")).toBe(2)
    expect(count(after, "curation_run")).toBe(0)
    expect(count(after, "curation_proposal")).toBe(0)
    expect(count(after, "operation_metric")).toBe(1)
    after.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("archive import-memory defaults to dry-run", async () => {
    const dir = makeWorktree("engram-cli-import-dry-")
    const archiveRoot = path.join(dir, "archives")
    writeFileSync(
      path.join(dir, ".opencode", "engram.json"),
      `${JSON.stringify({ archive: { path: archiveRoot } })}\n`,
    )
    mkdirSync(path.join(archiveRoot, "p1"), { recursive: true })
    const archiveRel = path.join("p1", "root.jsonl.gz")
    const archiveAbs = path.join(archiveRoot, archiveRel)
    const jsonl = [
      { kind: "session", id: "root", project_id: "p1", parent_id: null, time_created: 1, time_updated: 2 },
      { kind: "message", id: "m1", session_id: "root", time_created: 3, data: { role: "assistant", agent: "worker" } },
      { kind: "part", id: "part1", message_id: "m1", session_id: "root", time_created: 4, data: { type: "text", text: "durable imported memory" } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")
    writeFileSync(archiveAbs, gzipSync(`${jsonl}\n`))

    const db = openMemoryDb(path.join(dir, ".opencode", "memory.db"))
    db.prepare(
      `INSERT INTO archive (
        id, root_session_id, project_id, session_count, message_count, part_count,
        archive_path, archive_size, content_hash, time_created
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("a1", "root", "p1", 1, 1, 1, archiveRel, 1, "not-checked-by-import", Date.now())
    db.close()

    await runCli(["archive", "import-memory", "root", "--project-id", "p1", "--worktree", dir])

    const afterDry = openMemoryDb(path.join(dir, ".opencode", "memory.db"))
    expect(count(afterDry, "chunk")).toBe(0)
    afterDry.close()

    await runCli(["archive", "import-memory", "--apply", "root", "--project-id", "p1", "--worktree", dir])
    const afterApply = openMemoryDb(path.join(dir, ".opencode", "memory.db"))
    expect(count(afterApply, "chunk")).toBe(1)
    afterApply.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("--help exits successfully", async () => {
    const result = await runCli(["--help"])
    expect(result.stdout).toContain("Examples:")
  })
})

function makeWorktree(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  return dir
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: path.resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  return { stdout, stderr }
}

function insertChunk(db: ReturnType<typeof openMemoryDb>, id: string, content: string, hash: string) {
  db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "s1",
    `${id}-message`,
    `${id}-part`,
    "p1",
    "assistant",
    "test",
    null,
    "decision",
    content,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    Date.now(),
    hash,
    "s1",
    0,
    null,
  )
}

function count(db: ReturnType<typeof openMemoryDb>, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}
