/**
 * Plugin lifecycle dashboard.
 *
 * Reads ndjson lines from `~/.local/share/opencode/log/plugin-lifecycle.jsonl`
 * (emitted by `@jackmazac/opencode-host-adapter`) and produces per-plugin
 * load and tool execution metrics.
 *
 * Used by:
 *   engram dashboard --plugins
 *   engram dashboard --plugins --json
 *
 * Designed for terminal output by default; --json emits the same data as
 * a structured object for scripting.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "log",
  "plugin-lifecycle.jsonl",
)

type LifecycleEvent = {
  kind: string
  plugin?: string
  tool?: string
  ts?: number
  durationMs?: number
  status?: string
  toolCount?: number
  hookKinds?: string[]
  error?: { message?: string; name?: string }
  message?: string
  trace_id?: string
}

export type PluginDashboardReport = {
  generatedAt: string
  source: string
  totalEvents: number
  perPlugin: Array<{
    plugin: string
    loadCount: number
    lastLoadAt: number | null
    lastLoadDurationMs: number | null
    loadDurationP50Ms: number | null
    loadDurationP95Ms: number | null
    toolCount: number | null
    hookKinds: string[]
    toolsExecuted: number
    toolsFailed: number
    toolDurationP50Ms: number | null
    toolDurationP95Ms: number | null
    validationFailures: number
    hookFailures: number
    pluginFailures: number
    recentFailures: Array<{ kind: string; ts: number; tool?: string; message: string }>
  }>
}

export type PluginDashboardOptions = {
  /** Override source path; defaults to ~/.local/share/opencode/log/plugin-lifecycle.jsonl. */
  path?: string
  /** Maximum recent failures to surface per plugin (default 5). */
  recentFailureLimit?: number
}

export function buildPluginDashboardReport(opts: PluginDashboardOptions = {}): PluginDashboardReport {
  const path = opts.path ?? DEFAULT_PATH
  const recentFailureLimit = opts.recentFailureLimit ?? 5

  if (!existsSync(path)) {
    return {
      generatedAt: new Date().toISOString(),
      source: path,
      totalEvents: 0,
      perPlugin: [],
    }
  }

  const events: LifecycleEvent[] = []
  const raw = readFileSync(path, "utf8")
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as LifecycleEvent
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
        events.push(parsed)
      }
    } catch {
      // Skip malformed lines.
    }
  }

  const groups = new Map<string, LifecycleEvent[]>()
  for (const event of events) {
    const plugin = event.plugin ?? "<unknown>"
    const list = groups.get(plugin) ?? []
    list.push(event)
    groups.set(plugin, list)
  }

  const perPlugin: PluginDashboardReport["perPlugin"] = []
  for (const [plugin, list] of groups.entries()) {
    const loads = list.filter((e) => e.kind === "plugin.loaded")
    const loadDurations = loads
      .map((e) => e.durationMs)
      .filter((d): d is number => typeof d === "number")
    const lastLoad = loads.length > 0 ? loads[loads.length - 1] : undefined
    const toolExecuted = list.filter((e) => e.kind === "tool.executed")
    const toolFailed = list.filter((e) => e.kind === "tool.failed")
    const toolDurations = [...toolExecuted, ...toolFailed]
      .map((e) => e.durationMs)
      .filter((d): d is number => typeof d === "number")
    const validationFailures = list.filter((e) => e.kind === "plugin.validation_failed")
    const hookFailures = list.filter((e) => e.kind === "hook.failed")
    const pluginFailures = list.filter((e) => e.kind === "plugin.failed")

    const failureCandidates = [...toolFailed, ...hookFailures, ...validationFailures, ...pluginFailures]
    failureCandidates.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    const recentFailures = failureCandidates.slice(0, recentFailureLimit).map((e) => {
      const entry: { kind: string; ts: number; tool?: string; message: string } = {
        kind: e.kind,
        ts: e.ts ?? 0,
        message: e.error?.message ?? e.message ?? "",
      }
      if (e.tool) entry.tool = e.tool
      return entry
    })

    perPlugin.push({
      plugin,
      loadCount: loads.length,
      lastLoadAt: lastLoad?.ts ?? null,
      lastLoadDurationMs: lastLoad?.durationMs ?? null,
      loadDurationP50Ms: percentile(loadDurations, 0.5),
      loadDurationP95Ms: percentile(loadDurations, 0.95),
      toolCount: lastLoad?.toolCount ?? null,
      hookKinds: lastLoad?.hookKinds ?? [],
      toolsExecuted: toolExecuted.length,
      toolsFailed: toolFailed.length,
      toolDurationP50Ms: percentile(toolDurations, 0.5),
      toolDurationP95Ms: percentile(toolDurations, 0.95),
      validationFailures: validationFailures.length,
      hookFailures: hookFailures.length,
      pluginFailures: pluginFailures.length,
      recentFailures,
    })
  }

  perPlugin.sort((a, b) => a.plugin.localeCompare(b.plugin))

  return {
    generatedAt: new Date().toISOString(),
    source: path,
    totalEvents: events.length,
    perPlugin,
  }
}

export function formatPluginDashboardReport(report: PluginDashboardReport): string {
  const lines: string[] = []
  lines.push(`Plugin lifecycle dashboard`)
  lines.push(`source: ${report.source}`)
  lines.push(`generated: ${report.generatedAt}`)
  lines.push(`total events: ${report.totalEvents}`)
  lines.push("")

  if (report.perPlugin.length === 0) {
    lines.push("(no plugin events yet — start opencode with at least one wrapped plugin)")
    return lines.join("\n")
  }

  for (const p of report.perPlugin) {
    lines.push(`▸ ${p.plugin}`)
    lines.push(
      `  loads: ${p.loadCount} | last: ${formatTs(p.lastLoadAt)} (${formatMs(p.lastLoadDurationMs)})`,
    )
    if (p.loadDurationP50Ms !== null) {
      lines.push(
        `  load duration: p50=${formatMs(p.loadDurationP50Ms)} p95=${formatMs(p.loadDurationP95Ms)}`,
      )
    }
    lines.push(
      `  tools: ${p.toolCount ?? "?"} registered | hooks: ${p.hookKinds.join(", ") || "(none)"}`,
    )
    lines.push(
      `  executions: ${p.toolsExecuted} ok / ${p.toolsFailed} failed | tool duration: p50=${formatMs(p.toolDurationP50Ms)} p95=${formatMs(p.toolDurationP95Ms)}`,
    )
    if (p.validationFailures + p.hookFailures + p.pluginFailures > 0) {
      lines.push(
        `  failures: ${p.pluginFailures} plugin / ${p.validationFailures} validation / ${p.hookFailures} hook`,
      )
    }
    if (p.recentFailures.length > 0) {
      lines.push(`  recent failures:`)
      for (const f of p.recentFailures) {
        const tag = f.tool ? `${f.kind}:${f.tool}` : f.kind
        const msg = f.message.length > 120 ? `${f.message.slice(0, 120)}…` : f.message
        lines.push(`    [${formatTs(f.ts)}] ${tag} — ${msg}`)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  const v = sorted[index]
  return v === undefined ? null : Math.round(v * 100) / 100
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "?"
  if (value < 1) return `${value.toFixed(2)}ms`
  if (value < 1000) return `${value.toFixed(1)}ms`
  return `${(value / 1000).toFixed(2)}s`
}

function formatTs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "never"
  return new Date(value).toISOString().replace("T", " ").slice(0, 19)
}
