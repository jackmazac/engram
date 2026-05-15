import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import { buildArtifactRef } from "@mazac-fox/opencode-fleet-contracts";
import type { EngramConfig } from "./config.ts";
import { insertChunkCorrelation } from "./db.ts";
import { withArtifactCorrelation } from "./fleet.ts";
import { contentHash } from "./hash.ts";
import type { EngramCorrelation } from "./types.ts";

export type ArtifactKind =
  | "journal"
  | "plan"
  | "audit"
  | "progress"
  | "audit_progress"
  | "status"
  | "handoff"
  | "lifecycle"
  | "concord_collision"
  | "concord_guidance";

export type ArtifactIngestSummary = {
  runId: string;
  dryRun: boolean;
  discovered: number;
  sourcesChanged: number;
  items: number;
  chunksInserted: number;
  artifact_refs: string[];
  lifecycle_object_ids: string[];
  errors: string[];
};

type Source = { kind: ArtifactKind; file: string; rel: string };
type Item = {
  kind: ArtifactKind;
  title: string | null;
  slug: string | null;
  content: string;
  time: number;
};

const authority: Record<ArtifactKind, number> = {
  journal: 10,
  plan: 8,
  audit: 8,
  progress: 7,
  audit_progress: 7,
  lifecycle: 8,
  concord_collision: 8,
  concord_guidance: 8,
  handoff: 6,
  status: 3,
};

export function ingestArtifacts(opts: {
  db: Database;
  worktree: string;
  projectId: string;
  cfg: EngramConfig;
  dryRun: boolean;
  kinds?: string[];
  max?: number;
  correlation?: EngramCorrelation | null;
}): ArtifactIngestSummary {
  const runId = ulid();
  const sources = discoverSources(opts.worktree, opts.cfg).filter(
    (s) => !opts.kinds?.length || opts.kinds.includes(s.kind),
  );
  const errors: string[] = [];
  let sourcesChanged = 0;
  let items = 0;
  let chunksInserted = 0;
  const artifactRefs = new Set<string>();
  const lifecycleObjectIds = new Set<string>();
  const max = opts.max ?? Number.POSITIVE_INFINITY;

  const sourceRows: Array<{
    source: Source;
    hash: string;
    mtime: number;
    size: number;
    parsed: Item[];
  }> = [];
  for (const source of sources.slice(0, max)) {
    try {
      const st = statSync(source.file);
      const raw = readFileSync(source.file, "utf8");
      const hash = sha256(raw);
      const existing = opts.db
        .prepare(`SELECT content_hash FROM artifact_source WHERE project_id = ? AND path = ?`)
        .get(opts.projectId, source.rel) as { content_hash: string } | undefined;
      const parsed = parseSource(source, raw, st.mtimeMs);
      sourceRows.push({ source, hash, mtime: Math.floor(st.mtimeMs), size: st.size, parsed });
      if (existing?.content_hash !== hash) sourcesChanged++;
      items += parsed.length;
    } catch (e) {
      errors.push(`${source.rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!opts.dryRun) {
    const now = Date.now();
    const upsertSource = opts.db.prepare(
      `INSERT INTO artifact_source (id, project_id, kind, path, content_hash, mtime_ms, size_bytes, last_ingested_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, path) DO UPDATE SET
         kind = excluded.kind,
         content_hash = excluded.content_hash,
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes,
         last_ingested_at = excluded.last_ingested_at`,
    );
    const getSource = opts.db.prepare(
      `SELECT id FROM artifact_source WHERE project_id = ? AND path = ?`,
    );
    const insertItem = opts.db.prepare(
      `INSERT OR IGNORE INTO artifact_item (
        id, source_id, project_id, kind, title, slug, content, content_hash, authority, time_created, time_updated
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const existingChunk = opts.db.prepare(
      `SELECT 1 FROM chunk WHERE project_id = ? AND source_ref = ? LIMIT 1`,
    );
    const insertChunk = opts.db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug,
        source_kind, source_ref, authority
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const tx = opts.db.transaction(() => {
      for (const row of sourceRows) {
        upsertSource.run(
          ulid(),
          opts.projectId,
          row.source.kind,
          row.source.rel,
          row.hash,
          row.mtime,
          row.size,
          now,
        );
        const src = getSource.get(opts.projectId, row.source.rel) as { id: string } | undefined;
        if (!src) continue;
        for (const item of row.parsed) {
          const h = contentHash(item.content);
          const canonical = buildArtifactRef({ kind: item.kind, path: row.source.rel, hash: h });
          const ref = canonical.ref;
          const lifecycleObjectId = lifecycleObjectIdFor(row.source, item);
          artifactRefs.add(ref);
          if (lifecycleObjectId) lifecycleObjectIds.add(lifecycleObjectId);
          insertItem.run(
            ulid(),
            src.id,
            opts.projectId,
            item.kind,
            item.title,
            item.slug,
            item.content,
            h,
            authority[item.kind],
            item.time,
            now,
          );
          if (existingChunk.get(opts.projectId, ref)) continue;
          const chunkId = ulid();
          insertChunk.run(
            chunkId,
            `artifact:${item.kind}`,
            ref,
            null,
            opts.projectId,
            "assistant",
            "engram-artifact",
            null,
            contentType(item.kind, item.content),
            item.content.slice(0, opts.cfg.sidecar.maxChunkLength),
            JSON.stringify([row.source.rel]),
            null,
            null,
            null,
            null,
            null,
            null,
            item.time,
            h,
            null,
            null,
            item.slug,
            item.kind,
            ref,
            authority[item.kind],
          );
          insertChunkCorrelation(opts.db, {
            chunk_id: chunkId,
            correlation: withArtifactCorrelation(opts.correlation, ref, lifecycleObjectId),
          });
          chunksInserted++;
        }
      }
      opts.db
        .prepare(
          `INSERT INTO artifact_ingest_run (id, project_id, mode, dry_run, summary_json, time_created) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          runId,
          opts.projectId,
          "artifact",
          0,
          JSON.stringify({ sources: sourceRows.length, items, chunksInserted, errors }),
          now,
        );
    });
    tx();
  }

  return {
    runId,
    dryRun: opts.dryRun,
    discovered: sources.length,
    sourcesChanged,
    items,
    chunksInserted,
    artifact_refs: [...artifactRefs],
    lifecycle_object_ids: [...lifecycleObjectIds],
    errors,
  };
}

export function formatArtifactIngestSummary(s: ArtifactIngestSummary): string {
  const lines = [
    `Artifact ingest ${s.dryRun ? "dry-run" : "applied"} ${s.runId}`,
    `discovered=${s.discovered} changed=${s.sourcesChanged} items=${s.items} chunksInserted=${s.chunksInserted}`,
  ];
  if (s.artifact_refs.length) lines.push(`artifact_refs=${s.artifact_refs.join(",")}`);
  if (s.lifecycle_object_ids.length)
    lines.push(`lifecycle_object_ids=${s.lifecycle_object_ids.join(",")}`);
  for (const e of s.errors.slice(0, 10)) lines.push(`error: ${e}`);
  return lines.join("\n");
}

function lifecycleObjectIdFor(source: Source, item: Item): string | null {
  if (source.kind === "concord_collision" || source.kind === "concord_guidance") {
    if (item.slug?.startsWith("concord:")) return `concord-event:${item.slug}`;
  }
  if (source.kind === "lifecycle") return `source-file:${source.rel}`;
  return null;
}

export function discoverSources(worktree: string, cfg: EngramConfig): Source[] {
  const p = cfg.integration.artifactPaths;
  const concordRel = normalizeRel(p.concord);
  return [
    ...walkKind(worktree, p.plans, "plan", [".md"]),
    ...walkKind(worktree, p.audits, "audit", [".md"]),
    ...fileKind(worktree, p.journal, "journal"),
    ...walkKind(worktree, p.progress, "progress", [".json"]),
    ...walkKind(worktree, p.auditProgress, "audit_progress", [".json"]),
    ...walkKind(worktree, p.status, "status", [".json"]),
    ...fileKind(worktree, p.handoff, "handoff"),
    ...walkKind(worktree, p.lifecycle, "lifecycle", [".json", ".md"]).filter(
      (source) => !normalizeRel(source.rel).startsWith(`${concordRel}/`),
    ),
    ...walkKind(worktree, p.concord, "concord_collision", [".json"]),
    ...walkKind(worktree, p.concord, "concord_guidance", [".xml", ".md"]),
  ];
}

function normalizeRel(rel: string): string {
  return rel.replace(/^\.\//, "").replace(/\\/g, "/");
}

function parseSource(source: Source, raw: string, mtime: number): Item[] {
  if (source.kind === "journal") return parseJournal(raw, mtime);
  if (source.kind === "lifecycle" || source.kind === "concord_collision") {
    return [parseStructuredArtifact(source, raw, mtime)].filter((x) => x.content);
  }
  if (source.kind === "plan" || source.kind === "audit")
    return parseMarkdownArtifact(source, raw, mtime);
  const title = firstTitle(raw) ?? path.basename(source.rel);
  const slug = path.basename(source.rel).replace(/\.[^.]+$/, "");
  return [{ kind: source.kind, title, slug, content: raw.trim(), time: Math.floor(mtime) }].filter(
    (x) => x.content,
  );
}

function parseMarkdownArtifact(source: Source, raw: string, mtime: number): Item[] {
  const fallbackTitle = firstTitle(raw) ?? path.basename(source.rel);
  const baseSlug = path.basename(source.rel).replace(/\.[^.]+$/, "");
  const sections = markdownSections(raw);
  if (sections.length === 0) {
    return [
      {
        kind: source.kind,
        title: fallbackTitle,
        slug: baseSlug,
        content: raw.trim(),
        time: Math.floor(mtime),
      },
    ].filter((x) => x.content);
  }
  return sections
    .map((section) => ({
      kind: source.kind,
      title: section.title,
      slug: `${baseSlug}-${slugify(section.title)}`,
      content: section.content,
      time: Math.floor(mtime),
    }))
    .filter((x) => x.content);
}

function markdownSections(raw: string): Array<{ title: string; content: string }> {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (/^##\s+/.test(line) && !/^###\s+/.test(line)) {
      if (current?.lines.join("\n").trim()) sections.push(current);
      current = { title: line.replace(/^##\s+/, "").trim(), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current?.lines.join("\n").trim()) sections.push(current);
  return sections.map((section) => ({
    title: section.title,
    content: section.lines.join("\n").trim(),
  }));
}

function parseStructuredArtifact(source: Source, raw: string, mtime: number): Item {
  const fallbackTitle = firstTitle(raw) ?? path.basename(source.rel);
  const slug = path.basename(source.rel).replace(/\.[^.]+$/, "");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const eventId =
      typeof parsed.event_id === "string"
        ? parsed.event_id
        : typeof parsed.eventId === "string"
          ? parsed.eventId
          : undefined;
    const kind = typeof parsed.kind === "string" ? parsed.kind : source.kind;
    const filePath =
      typeof parsed.file_path === "string"
        ? parsed.file_path
        : typeof parsed.filePath === "string"
          ? parsed.filePath
          : undefined;
    const title = [kind, eventId, filePath].filter(Boolean).join(" ") || fallbackTitle;
    return {
      kind: source.kind,
      title,
      slug: eventId ?? slug,
      content: JSON.stringify(parsed, null, 2),
      time: typeof parsed.ts === "number" ? parsed.ts : Math.floor(mtime),
    };
  } catch {
    return {
      kind: source.kind,
      title: fallbackTitle,
      slug,
      content: raw.trim(),
      time: Math.floor(mtime),
    };
  }
}

function parseJournal(raw: string, mtime: number): Item[] {
  const out: Item[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as Record<string, unknown>;
      const body =
        typeof row.content === "string"
          ? row.content
          : typeof row.body === "string"
            ? row.body
            : JSON.stringify(row);
      const type = typeof row.type === "string" ? row.type : "journal";
      out.push({
        kind: "journal",
        title: type,
        slug: type,
        content: body,
        time: typeof row.time === "number" ? row.time : Math.floor(mtime),
      });
    } catch {
      out.push({
        kind: "journal",
        title: "journal",
        slug: "journal",
        content: t,
        time: Math.floor(mtime),
      });
    }
  }
  return out;
}

function contentType(kind: ArtifactKind, content: string): string {
  if (kind === "journal") {
    const t = content.toLowerCase();
    if (t.includes("contract")) return "api_contract";
    if (t.includes("decision")) return "decision";
    if (t.includes("pattern")) return "pattern";
    return "decision";
  }
  if (kind === "audit") return content.toLowerCase().includes("bug") ? "bug" : "analysis";
  if (kind === "plan") return "plan";
  if (kind === "progress" || kind === "audit_progress") return "milestone";
  if (kind === "lifecycle") return "lifecycle_artifact";
  if (kind === "concord_collision") return "concord_collision";
  if (kind === "concord_guidance") return "concord_guidance";
  return "discovery";
}

function walkKind(worktree: string, rel: string, kind: ArtifactKind, exts: string[]): Source[] {
  const root = safeResolveInside(worktree, rel);
  if (!existsSync(root)) return [];
  const realWorktree = realpathSync(worktree);
  const realRoot = safeExistingInside(worktree, root);
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(file);
      else if (exts.includes(path.extname(ent.name))) {
        const realFile = safeExistingInside(worktree, file);
        out.push({
          kind,
          file: realFile,
          rel: normalizeRel(path.relative(realWorktree, realFile)),
        });
      }
    }
  };
  walk(realRoot);
  return out;
}

function fileKind(worktree: string, rel: string, kind: ArtifactKind): Source[] {
  const file = safeResolveInside(worktree, rel);
  if (!existsSync(file)) return [];
  const realRoot = realpathSync(worktree);
  const realFile = safeExistingInside(worktree, file);
  return [{ kind, file: realFile, rel: normalizeRel(path.relative(realRoot, realFile)) }];
}

function safeResolveInside(worktree: string, rel: string): string {
  if (rel.split(/[\\/]+/).includes("..")) throw new Error(`Artifact path escapes worktree: ${rel}`);
  const logicalRoot = path.resolve(worktree);
  const resolved = path.resolve(worktree, rel);
  if (!inside(logicalRoot, resolved)) throw new Error(`Artifact path escapes worktree: ${rel}`);
  return resolved;
}

function safeExistingInside(worktree: string, file: string): string {
  const realRoot = realpathSync(worktree);
  const realFile = realpathSync(file);
  if (!inside(realRoot, realFile)) throw new Error(`Artifact path escapes worktree: ${file}`);
  return realFile;
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function firstTitle(raw: string): string | null {
  for (const line of raw.split(/\r?\n/).slice(0, 20)) {
    const t = line.trim();
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "");
    if (t) return t.slice(0, 120);
  }
  return null;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
