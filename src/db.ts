import path from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { EngramConfig } from "./config.ts";
import type { ChunkCorrelationFilters, ChunkCorrelationRow, EngramCorrelation } from "./types.ts";

const busyMs = 5000;

/** WAL + safety for the Engram sidecar DB (create/migrate). */
export function applySidecarPragmas(db: Database) {
  db.run(`PRAGMA busy_timeout = ${busyMs};`);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
}

/** Shared hot CLI connection: FK checks + brief busy wait under contention. */
export function applyConnPragmas(db: Database) {
  db.run("PRAGMA foreign_keys = ON;");
  db.run(`PRAGMA busy_timeout = ${busyMs};`);
}

export function openMemoryDb(file: string): Database {
  const db = new Database(file, { create: true });
  applySidecarPragmas(db);
  migrate(db);
  return db;
}

export type SidecarHealth =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export type SidecarRepairResult = {
  repaired: boolean;
  dryRun: boolean;
  path: string;
  quarantineDir: string;
  files: string[];
};

export function checkSidecarHealth(file: string): SidecarHealth {
  if (!existsSync(file)) return { ok: false, error: `Sidecar does not exist: ${file}` };

  let db: Database | undefined;
  try {
    db = new Database(file);
    applyConnPragmas(db);
    db.exec("PRAGMA quick_check;");
    db.exec("SELECT count(*) FROM sqlite_schema;");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

export function repairSidecar(opts: { path: string; dryRun?: boolean }): SidecarRepairResult {
  const dryRun = opts.dryRun !== false;
  const files = sidecarFiles(opts.path).filter((file) => existsSync(file));
  const quarantineDir = path.join(
    path.dirname(opts.path),
    `.memory-quarantine-${repairTimestamp()}`,
  );

  if (dryRun) {
    return {
      repaired: false,
      dryRun,
      path: opts.path,
      quarantineDir,
      files,
    };
  }

  if (files.length > 0) {
    mkdirSync(quarantineDir, { recursive: true });
    for (const file of files) {
      renameSync(file, path.join(quarantineDir, path.basename(file)));
    }
  }

  const db = openMemoryDb(opts.path);
  db.close();

  return {
    repaired: true,
    dryRun,
    path: opts.path,
    quarantineDir,
    files,
  };
}

function sidecarFiles(file: string): string[] {
  return [file, `${file}-wal`, `${file}-shm`];
}

function repairTimestamp(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "");
}

export function migrate(db: Database) {
  const row = db.query("PRAGMA user_version;").get() as { user_version: number } | undefined;
  let v = Number(row?.user_version ?? 0);
  if (v < 1) {
    db.exec(`
CREATE TABLE IF NOT EXISTS chunk (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_id TEXT,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  file_paths TEXT,
  tool_name TEXT,
  tool_status TEXT,
  output_head TEXT,
  output_tail TEXT,
  output_length INTEGER,
  error_class TEXT,
  embedding BLOB,
  time_created INTEGER NOT NULL,
  time_embedded INTEGER,
  content_hash TEXT NOT NULL,
  root_session_id TEXT,
  session_depth INTEGER,
  plan_slug TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunk_session ON chunk(session_id);
CREATE INDEX IF NOT EXISTS idx_chunk_project ON chunk(project_id);
CREATE INDEX IF NOT EXISTS idx_chunk_type ON chunk(content_type);
CREATE INDEX IF NOT EXISTS idx_chunk_agent ON chunk(agent);
CREATE INDEX IF NOT EXISTS idx_chunk_time ON chunk(time_created);
CREATE INDEX IF NOT EXISTS idx_chunk_tool ON chunk(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_unembedded ON chunk(id) WHERE time_embedded IS NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_hash ON chunk(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_plan ON chunk(plan_slug) WHERE plan_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_root ON chunk(root_session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  chunk_id UNINDEXED,
  content,
  file_paths,
  tool_name,
  agent,
  content_type,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_id, content, file_paths, tool_name, agent, content_type)
  VALUES (
    new.id,
    new.content,
    coalesce(new.file_paths, ''),
    coalesce(new.tool_name, ''),
    coalesce(new.agent, ''),
    new.content_type
  );
END;

CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
  DELETE FROM chunk_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE ON chunk BEGIN
  DELETE FROM chunk_fts WHERE chunk_id = old.id;
  INSERT INTO chunk_fts(chunk_id, content, file_paths, tool_name, agent, content_type)
  VALUES (
    new.id,
    new.content,
    coalesce(new.file_paths, ''),
    coalesce(new.tool_name, ''),
    coalesce(new.agent, ''),
    new.content_type
  );
END;

CREATE TABLE IF NOT EXISTS archive (
  id TEXT PRIMARY KEY,
  root_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  archive_path TEXT NOT NULL,
  archive_size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archive_project ON archive(project_id);

CREATE TABLE IF NOT EXISTS type_proposal (
  id TEXT PRIMARY KEY,
  proposed_type TEXT NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES chunk(id),
  confidence REAL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_type_proposal ON type_proposal(proposed_type);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  query TEXT NOT NULL,
  returned_ids TEXT NOT NULL,
  referenced_ids TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_log(session_id);

CREATE TABLE IF NOT EXISTS friction_cache (
  id TEXT PRIMARY KEY,
  report TEXT NOT NULL,
  chunk_window TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_checkpoint (
  root_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  exported_message_id TEXT,
  exported_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER,
  phase TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_memory_last (
  session_id TEXT PRIMARY KEY,
  log_id TEXT NOT NULL,
  chunk_ids TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

PRAGMA user_version = 1;
  `);
    v = 1;
  }

  if (v < 2) {
    db.exec(`
ALTER TABLE export_checkpoint ADD COLUMN exported_part_id TEXT;
PRAGMA user_version = 2;
    `);
    v = 2;
  }

  if (v < 3) {
    db.exec(`
CREATE TABLE IF NOT EXISTS engram_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
PRAGMA user_version = 3;
    `);
    v = 3;
  }

  if (v < 4) {
    db.exec(`
DROP TRIGGER IF EXISTS chunk_au;

CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE OF content, file_paths, tool_name, agent, content_type ON chunk BEGIN
  DELETE FROM chunk_fts WHERE chunk_id = old.id;
  INSERT INTO chunk_fts(chunk_id, content, file_paths, tool_name, agent, content_type)
  VALUES (
    new.id,
    new.content,
    coalesce(new.file_paths, ''),
    coalesce(new.tool_name, ''),
    coalesce(new.agent, ''),
    new.content_type
  );
END;

CREATE INDEX IF NOT EXISTS idx_chunk_project_hash ON chunk(project_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_unembedded_project_time ON chunk(project_id, time_created) WHERE time_embedded IS NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_identity_hash ON chunk(project_id, session_id, message_id, coalesce(part_id, ''), content_hash);

PRAGMA user_version = 4;
    `);
    v = 4;
  }

  if (v < 5) {
    db.exec(`
ALTER TABLE chunk ADD COLUMN embedding_model TEXT;
ALTER TABLE chunk ADD COLUMN embedding_dimensions INTEGER;

UPDATE chunk SET time_embedded = NULL
WHERE embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_dimensions IS NULL);

CREATE INDEX IF NOT EXISTS idx_chunk_embedding_version
  ON chunk(project_id, embedding_model, embedding_dimensions)
  WHERE embedding IS NOT NULL;

PRAGMA user_version = 5;
    `);
    v = 5;
  }

  if (v < 6) {
    db.exec(`
CREATE TABLE export_checkpoint_next (
  root_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  exported_message_id TEXT,
  exported_part_id TEXT,
  exported_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER,
  phase TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, root_session_id)
);

INSERT OR REPLACE INTO export_checkpoint_next (
  root_session_id, project_id, exported_message_id, exported_part_id, exported_count, total_count, phase, updated_at
)
SELECT root_session_id, project_id, exported_message_id, exported_part_id, exported_count, total_count, phase, updated_at
FROM export_checkpoint;

DROP TABLE export_checkpoint;
ALTER TABLE export_checkpoint_next RENAME TO export_checkpoint;
CREATE INDEX IF NOT EXISTS idx_export_checkpoint_project ON export_checkpoint(project_id);

PRAGMA user_version = 6;
    `);
    v = 6;
  }

  if (v < 7) {
    db.exec(`
CREATE TABLE IF NOT EXISTS operation_metric (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  rows_count INTEGER,
  bytes_count INTEGER,
  heap_used_delta INTEGER,
  rss_delta INTEGER,
  detail TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_metric_project_time ON operation_metric(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_operation_metric_project_op_time ON operation_metric(project_id, operation, time_created DESC);

PRAGMA user_version = 7;
    `);
    v = 7;
  }

  if (v < 8) {
    db.exec(`
CREATE TABLE IF NOT EXISTS eval_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  fixture_name TEXT NOT NULL,
  fixture_hash TEXT NOT NULL,
  report_json TEXT NOT NULL,
  recall_at_k REAL NOT NULL,
  mrr REAL NOT NULL,
  p50_ms REAL NOT NULL,
  p95_ms REAL NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_run_project_time ON eval_run(project_id, time_created DESC);

PRAGMA user_version = 8;
    `);
    v = 8;
  }

  if (v < 9) {
    db.exec(`
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  session_id TEXT,
  rating TEXT NOT NULL,
  note TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_project_chunk ON retrieval_feedback(project_id, chunk_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_project_time ON retrieval_feedback(project_id, time_created DESC);

PRAGMA user_version = 9;
    `);
    v = 9;
  }

  if (v < 10) {
    db.exec(`
CREATE TABLE IF NOT EXISTS curation_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  applied INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS curation_proposal (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES curation_run(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  duplicate_of TEXT,
  score REAL,
  applied INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curation_run_project_time ON curation_run(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_curation_proposal_project_action ON curation_proposal(project_id, action);

PRAGMA user_version = 10;
    `);
    v = 10;
  }

  if (v < 11) {
    db.exec(`
ALTER TABLE chunk ADD COLUMN source_kind TEXT;
ALTER TABLE chunk ADD COLUMN source_ref TEXT;
ALTER TABLE chunk ADD COLUMN authority REAL NOT NULL DEFAULT 0;
ALTER TABLE chunk ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_chunk_project_source_ref ON chunk(project_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_project_authority ON chunk(project_id, authority DESC);
CREATE INDEX IF NOT EXISTS idx_chunk_project_superseded ON chunk(project_id, superseded_by) WHERE superseded_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifact_source (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_ms INTEGER,
  size_bytes INTEGER,
  last_ingested_at INTEGER NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS artifact_item (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES artifact_source(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  slug TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  authority REAL NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  UNIQUE(project_id, source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS artifact_ingest_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_root_index (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  title TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  child_count INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  assistant_count INTEGER NOT NULL,
  user_count INTEGER NOT NULL,
  tool_count INTEGER NOT NULL,
  patch_count INTEGER NOT NULL,
  reasoning_count INTEGER NOT NULL,
  primary_agents_json TEXT NOT NULL,
  priority_score REAL NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  UNIQUE(project_id, root_session_id)
);

CREATE TABLE IF NOT EXISTS session_distillation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  model TEXT,
  summary_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE(project_id, root_session_id, source_hash)
);

CREATE TABLE IF NOT EXISTS memory_relation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_chunk_id TEXT NOT NULL,
  to_chunk_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE(project_id, from_chunk_id, to_chunk_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_artifact_source_project_kind ON artifact_source(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifact_item_project_kind ON artifact_item(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifact_ingest_project_time ON artifact_ingest_run(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_session_root_project_score ON session_root_index(project_id, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_distillation_project_root ON session_distillation(project_id, root_session_id);
CREATE INDEX IF NOT EXISTS idx_memory_relation_project_from ON memory_relation(project_id, from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_memory_relation_project_to ON memory_relation(project_id, to_chunk_id);

PRAGMA user_version = 11;
    `);
    v = 11;
  }

  if (v < 12) {
    db.exec(`
CREATE TABLE IF NOT EXISTS log_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  event TEXT NOT NULL,
  operation TEXT,
  status TEXT,
  message TEXT,
  detail TEXT,
  duration_ms REAL,
  rows_count INTEGER,
  bytes_count INTEGER,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_event_project_time ON log_event(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_log_event_project_level_time ON log_event(project_id, level, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_log_event_project_category_time ON log_event(project_id, category, time_created DESC);

PRAGMA user_version = 12;
    `);
    v = 12;
  }

  if (v < 13) {
    db.exec(`
CREATE TABLE IF NOT EXISTS chunk_correlation (
  chunk_id TEXT PRIMARY KEY REFERENCES chunk(id) ON DELETE CASCADE,
  workspace_id TEXT,
  plan_id TEXT,
  wave_id TEXT,
  agent_run_id TEXT,
  correlation_id TEXT,
  tool_call_id TEXT,
  spine_seq INTEGER,
  artifact_ref TEXT,
  lifecycle_object_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_cc_workspace ON chunk_correlation(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cc_plan ON chunk_correlation(plan_id);
CREATE INDEX IF NOT EXISTS idx_cc_wave ON chunk_correlation(wave_id);
CREATE INDEX IF NOT EXISTS idx_cc_agent_run ON chunk_correlation(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_cc_correlation ON chunk_correlation(correlation_id);
CREATE INDEX IF NOT EXISTS idx_cc_tool_call ON chunk_correlation(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_cc_spine ON chunk_correlation(spine_seq);
CREATE INDEX IF NOT EXISTS idx_cc_artifact ON chunk_correlation(artifact_ref);
CREATE INDEX IF NOT EXISTS idx_cc_lifecycle ON chunk_correlation(lifecycle_object_id);
    `);
    addColumnIfMissing(db, "operation_metric", "workspace_id", "TEXT");
    addColumnIfMissing(db, "operation_metric", "correlation_id", "TEXT");
    addColumnIfMissing(db, "log_event", "workspace_id", "TEXT");
    addColumnIfMissing(db, "log_event", "correlation_id", "TEXT");
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_operation_metric_workspace_time ON operation_metric(workspace_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_operation_metric_correlation_time ON operation_metric(correlation_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_log_event_workspace_time ON log_event(workspace_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_log_event_correlation_time ON log_event(correlation_id, time_created DESC);

PRAGMA user_version = 13;
    `);
    v = 13;
  }

  if (v < 14) {
    db.exec(`
CREATE TABLE IF NOT EXISTS backfill_job (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor_json TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  processed_roots INTEGER NOT NULL DEFAULT 0,
  processed_parts INTEGER NOT NULL DEFAULT 0,
  inserted_chunks INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_started INTEGER,
  time_finished INTEGER
);

CREATE INDEX IF NOT EXISTS idx_backfill_job_project_status
  ON backfill_job(project_id, status, time_updated DESC);
CREATE INDEX IF NOT EXISTS idx_backfill_job_project_kind
  ON backfill_job(project_id, kind, strategy, time_updated DESC);
CREATE INDEX IF NOT EXISTS idx_backfill_job_lease
  ON backfill_job(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

PRAGMA user_version = 14;
    `);
    v = 14;
  }
}

export const migrateMemoryDb = migrate;

export type BackfillJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type BackfillJobRow = {
  id: string;
  project_id: string;
  kind: string;
  strategy: string;
  status: BackfillJobStatus;
  cursor_json: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  processed_roots: number;
  processed_parts: number;
  inserted_chunks: number;
  error_summary: string | null;
  time_created: number;
  time_updated: number;
  time_started: number | null;
  time_finished: number | null;
};

export function createBackfillJob(
  db: Database,
  input: {
    projectId: string;
    kind: string;
    strategy: string;
    cursor?: Record<string, unknown> | null;
    now?: number;
  },
): BackfillJobRow {
  const now = input.now ?? Date.now();
  const id = ulid();
  db.prepare(
    `INSERT INTO backfill_job (
      id, project_id, kind, strategy, status, cursor_json, lease_owner, lease_expires_at,
      processed_roots, processed_parts, inserted_chunks, error_summary, time_created, time_updated,
      time_started, time_finished
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.kind,
    input.strategy,
    "pending",
    serializeCursor(input.cursor ?? null),
    null,
    null,
    0,
    0,
    0,
    null,
    now,
    now,
    null,
    null,
  );
  const job = readBackfillJob(db, id);
  if (!job) throw new Error(`backfill job was not created: ${id}`);
  return job;
}

export function readBackfillJob(db: Database, jobId: string): BackfillJobRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, kind, strategy, status, cursor_json, lease_owner, lease_expires_at,
              processed_roots, processed_parts, inserted_chunks, error_summary, time_created,
              time_updated, time_started, time_finished
       FROM backfill_job WHERE id = ?`,
    )
    .get(jobId);
  return isBackfillJobRow(row) ? row : null;
}

export function leaseBackfillJob(
  db: Database,
  input: { jobId: string; leaseOwner: string; leaseMs: number; now?: number },
): BackfillJobRow | null {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE backfill_job
     SET status = 'running',
         lease_owner = ?,
         lease_expires_at = ?,
         time_started = coalesce(time_started, ?),
         time_updated = ?
     WHERE id = ?
       AND status IN ('pending', 'running')
       AND (status = 'pending' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  ).run(input.leaseOwner, now + input.leaseMs, now, now, input.jobId, now);
  const job = readBackfillJob(db, input.jobId);
  return job?.lease_owner === input.leaseOwner && job.status === "running" ? job : null;
}

export function updateBackfillJobProgress(
  db: Database,
  input: {
    jobId: string;
    cursor?: Record<string, unknown> | null;
    processedRoots: number;
    processedParts: number;
    insertedChunks: number;
    now?: number;
  },
): BackfillJobRow | null {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE backfill_job
     SET cursor_json = ?,
         processed_roots = ?,
         processed_parts = ?,
         inserted_chunks = ?,
         time_updated = ?
     WHERE id = ? AND status = 'running'`,
  ).run(
    serializeCursor(input.cursor ?? null),
    input.processedRoots,
    input.processedParts,
    input.insertedChunks,
    now,
    input.jobId,
  );
  return readBackfillJob(db, input.jobId);
}

export function finishBackfillJob(
  db: Database,
  input: {
    jobId: string;
    status: "completed" | "failed" | "cancelled";
    errorSummary?: string | null;
    now?: number;
  },
): BackfillJobRow | null {
  const now = input.now ?? Date.now();
  db.prepare(
    `UPDATE backfill_job
     SET status = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         error_summary = ?,
         time_updated = ?,
         time_finished = ?
     WHERE id = ? AND status IN ('pending', 'running')`,
  ).run(input.status, input.errorSummary ?? null, now, now, input.jobId);
  return readBackfillJob(db, input.jobId);
}

export function cancelBackfillJob(
  db: Database,
  input: { jobId: string; now?: number },
): BackfillJobRow | null {
  return finishBackfillJob(db, { jobId: input.jobId, status: "cancelled", now: input.now });
}

export function countStaleBackfillJobs(db: Database, now: number = Date.now()): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM backfill_job
       WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .get(now);
  return isCountRow(row) ? row.n : 0;
}

export function insertChunkCorrelation(
  db: Database,
  input: { chunk_id: string; correlation: EngramCorrelation | null | undefined },
): void {
  const correlation = input.correlation;
  if (!correlation || !hasAnyCorrelation(correlation)) return;
  db.prepare(
    `INSERT OR REPLACE INTO chunk_correlation (
      chunk_id, workspace_id, plan_id, wave_id, agent_run_id, correlation_id, tool_call_id,
      spine_seq, artifact_ref, lifecycle_object_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.chunk_id,
    nullableString(correlation.workspace_id),
    nullableString(correlation.plan_id),
    nullableString(correlation.wave_id),
    nullableString(correlation.agent_run_id),
    nullableString(correlation.correlation_id),
    nullableString(correlation.tool_call_id),
    correlation.spine_seq ?? null,
    nullableString(correlation.artifact_ref),
    nullableString(correlation.lifecycle_object_id),
  );
}

export function readChunkCorrelation(db: Database, chunkId: string): ChunkCorrelationRow | null {
  const row = db
    .prepare(
      `SELECT chunk_id, workspace_id, plan_id, wave_id, agent_run_id, correlation_id, tool_call_id,
              spine_seq, artifact_ref, lifecycle_object_id
       FROM chunk_correlation WHERE chunk_id = ?`,
    )
    .get(chunkId);
  return isChunkCorrelationRow(row) ? row : null;
}

export function queryChunksByCorrelation(db: Database, filters: ChunkCorrelationFilters): string[] {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  addFilter(clauses, args, "workspace_id", filters.workspace_id);
  addFilter(clauses, args, "plan_id", filters.plan_id);
  addFilter(clauses, args, "wave_id", filters.wave_id);
  addFilter(clauses, args, "agent_run_id", filters.agent_run_id);
  addFilter(clauses, args, "correlation_id", filters.correlation_id);
  addFilter(clauses, args, "tool_call_id", filters.tool_call_id);
  addFilter(clauses, args, "artifact_ref", filters.artifact_ref);
  addFilter(clauses, args, "lifecycle_object_id", filters.lifecycle_object_id);
  addFilter(clauses, args, "spine_seq", filters.spine_seq);
  if (clauses.length === 0) return [];
  const rows = db
    .prepare(`SELECT chunk_id FROM chunk_correlation WHERE ${clauses.join(" AND ")} LIMIT 500`)
    .all(...args);
  return rows.flatMap((row) => (isChunkIdRow(row) ? [row.chunk_id] : []));
}

export function chunkCorrelationFiltersFromContext(
  correlation: EngramCorrelation | null | undefined,
): ChunkCorrelationFilters {
  if (!correlation) return {};
  return {
    workspace_id: nullableString(correlation.workspace_id),
    plan_id: nullableString(correlation.plan_id),
    wave_id: nullableString(correlation.wave_id),
    agent_run_id: nullableString(correlation.agent_run_id),
    correlation_id: nullableString(correlation.correlation_id),
    tool_call_id: nullableString(correlation.tool_call_id),
    spine_seq: correlation.spine_seq ?? null,
    artifact_ref: nullableString(correlation.artifact_ref),
    lifecycle_object_id: nullableString(correlation.lifecycle_object_id),
  };
}

function hasAnyCorrelation(correlation: EngramCorrelation): boolean {
  return Object.values(chunkCorrelationFiltersFromContext(correlation)).some(
    (value) => value !== null,
  );
}

function nullableString(value: string | number | null): string | null {
  if (value === null) return null;
  return String(value);
}

function addFilter(
  clauses: string[],
  args: Array<string | number>,
  column: keyof ChunkCorrelationRow,
  value: string | number | null | undefined,
): void {
  if (value === undefined || value === null || column === "chunk_id") return;
  clauses.push(`${column} = ?`);
  args.push(value);
}

function isChunkIdRow(value: unknown): value is { chunk_id: string } {
  return isRecord(value) && typeof value.chunk_id === "string";
}

function isBackfillJobRow(value: unknown): value is BackfillJobRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.project_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.strategy === "string" &&
    isBackfillJobStatus(value.status) &&
    isNullableString(value.cursor_json) &&
    isNullableString(value.lease_owner) &&
    isNullableNumber(value.lease_expires_at) &&
    typeof value.processed_roots === "number" &&
    typeof value.processed_parts === "number" &&
    typeof value.inserted_chunks === "number" &&
    isNullableString(value.error_summary) &&
    typeof value.time_created === "number" &&
    typeof value.time_updated === "number" &&
    isNullableNumber(value.time_started) &&
    isNullableNumber(value.time_finished)
  );
}

function isBackfillJobStatus(value: unknown): value is BackfillJobStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isCountRow(value: unknown): value is { n: number } {
  return isRecord(value) && typeof value.n === "number";
}

function isChunkCorrelationRow(value: unknown): value is ChunkCorrelationRow {
  return (
    isRecord(value) &&
    typeof value.chunk_id === "string" &&
    isNullableString(value.workspace_id) &&
    isNullableString(value.plan_id) &&
    isNullableString(value.wave_id) &&
    isNullableString(value.agent_run_id) &&
    isNullableString(value.correlation_id) &&
    isNullableString(value.tool_call_id) &&
    isNullableNumber(value.spine_seq) &&
    isNullableString(value.artifact_ref) &&
    isNullableString(value.lifecycle_object_id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function serializeCursor(cursor: Record<string, unknown> | null): string | null {
  return cursor === null ? null : JSON.stringify(cursor);
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all();
  return rows.some((row) => isRecord(row) && row.name === column);
}

export function sidecarPath(worktree: string, cfg: EngramConfig): string {
  const p = cfg.sidecar.path;
  if (path.isAbsolute(p)) return p;
  return path.join(worktree, p);
}
