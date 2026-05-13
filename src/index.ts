import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { wrapPlugin } from "@jackmazac/opencode-host-adapter";
import { resolvePluginToolSurfaceMaxChars } from "./config.ts";
import { getRuntime } from "./runtime.ts";
import { correlationFromUnknown } from "./fleet.ts";
import { applyToolSurfaceBudget } from "./plugin-tool-budget.ts";

const z = tool.schema;

/**
 * Bus `event` shape: `{ type, properties }` (see opencode `Bus.publish`).
 * OpenAI: `OPENAI_API_KEY` or `engram.jsonc` `openaiApiKey`. Plugin host does not expose `Config.get()`.
 * Archive export / delete: use `engram` CLI (this package `"bin"`).
 */
export const EngramPlugin: Plugin = async (input) => {
  const rt = getRuntime(input);
  if (!rt.cfg.enabled) return {};

  return {
    event: async ({ event }) => {
      const ev = event as { type?: string; properties?: Record<string, unknown> };
      if (ev.type === "message.updated") rt.onMessageUpdated(ev as never);
      if (ev.type === "message.part.updated") rt.onPartUpdated(ev as never);
      if (ev.type === "session.idle") rt.onSessionIdle(ev as never);
    },
    "tool.execute.after": async (i, o) => {
      rt.onToolAfter(i.tool, i.sessionID, o.output, i);
    },
    "experimental.chat.system.transform": async (i, o) => {
      await rt.injectSystem(i.sessionID, o.system);
    },
    tool: applyToolSurfaceBudget(
      {
      memory: tool({
        description:
          "Search project memory for relevant past work: decisions, analyses, patterns, errors, and reasoning from previous sessions.",
        args: {
          query: z.string().describe("Natural language query — what you want to find"),
          scope: z
            .string()
            .optional()
            .describe(
              "Default is high-precision agent context. Use broad or forensic for raw hybrid search; other values map to context mode/scope hints.",
            ),
          limit: z.number().optional().describe("Max results (default 5, max 10)"),
        },
        async execute(args, ctx) {
          return rt.memoryTool(
            args.query,
            args.scope,
            args.limit,
            ctx.sessionID,
            correlationFromUnknown(args, ctx),
          );
        },
      }),
      forget: tool({
        description:
          "Remove chunks from project memory. Preview by default (dry_run). Use to redact sensitive content.",
        args: {
          chunk_ids: z.array(z.string()).optional().describe("Chunk IDs to delete"),
          session_id: z.string().optional().describe("Delete all chunks for this session"),
          pattern: z.string().optional().describe("FTS match pattern — preview counts first"),
          dry_run: z.boolean().optional().describe("If true (default), only preview"),
        },
        async execute(args) {
          return rt.forgetTool({
            chunk_ids: args.chunk_ids,
            session_id: args.session_id,
            pattern: args.pattern,
            dry_run: args.dry_run,
          });
        },
      }),
      memory_feedback: tool({
        description:
          "Record whether a returned memory chunk was useful so future retrieval can learn from feedback.",
        args: {
          chunk_id: z.string().describe("Memory chunk id to rate"),
          rating: z.enum(["up", "down"]).describe("up = useful, down = not useful"),
          note: z.string().optional().describe("Optional short reason"),
        },
        async execute(args, ctx) {
          return rt.feedbackTool({
            chunk_id: args.chunk_id,
            rating: args.rating,
            note: args.note,
            session_id: ctx.sessionID,
          });
        },
      }),
      memory_context: tool({
        description:
          "Build a bounded preflight context bundle from high-authority project memory before planning or review.",
        args: {
          query: z.string().describe("Planning/review topic to retrieve context for"),
          mode: z
            .enum(["plan", "implement", "review", "debug", "audit", "handoff"])
            .optional()
            .describe("Context mode: plan | implement | review | debug | audit | handoff"),
          limit: z
            .number()
            .optional()
            .describe("Max raw memories to inspect before grouping (default 12)"),
          budget_chars: z
            .number()
            .optional()
            .describe("Approximate max characters in returned bundle"),
        },
        async execute(args, ctx) {
          return rt.contextTool({
            query: args.query,
            limit: args.limit,
            mode: args.mode,
            budgetChars: args.budget_chars,
            correlation: correlationFromUnknown(args, ctx),
          });
        },
      }),
      conflict_context: tool({
        description:
          "Fetch correlation-aware context bundle from Engram memory by fleet IDs (plan/wave/agent/correlation/tool/artifact/lifecycle/concord_event).",
        args: {
          query: z.string(),
          mode: z.string().optional(),
          limit: z.number().optional(),
          budget_chars: z.number().optional(),
          workspace_id: z.string().optional(),
          plan_id: z.string().optional(),
          plan_slug: z.string().optional(),
          wave_id: z.string().optional(),
          agent_run_id: z.string().optional(),
          correlation_id: z.string().optional(),
          tool_call_id: z.string().optional(),
          spine_seq: z.number().optional(),
          artifact_ref: z.string().optional(),
          artifact_refs: z.array(z.string()).optional(),
          lifecycle_object_id: z.string().optional(),
          lifecycle_object_ids: z.array(z.string()).optional(),
          concord_event_id: z.string().optional(),
          concord_event_ids: z.array(z.string()).optional(),
        },
        async execute(args, ctx) {
          const result = rt.runConflictContext({
            ...fleetArgs(correlationFromUnknown(ctx)),
            ...args,
            correlation: correlationFromUnknown(args, ctx),
          });
          return { output: JSON.stringify(result, null, 2), metadata: result };
        },
      }),
      lifecycle_ingest: tool({
        description:
          "Ingest file-based lifecycle artifacts (plans/runs/lifecycle/concord collisions) into Engram memory. Dry-run by default.",
        args: {
          apply: z.boolean().optional(),
          worktree_root: z.string().optional(),
        },
        async execute(args, ctx) {
          const result = rt.runLifecycleIngest({
            apply: args.apply === true,
            worktree_root: args.worktree_root,
            correlation: correlationFromUnknown(args, ctx),
          });
          return { output: JSON.stringify(result, null, 2), metadata: result };
        },
      }),
      stats: tool({
        description:
          "Project memory statistics: overview, db-health, telemetry, insights (cached).",
        args: {
          report: z
            .string()
            .optional()
            .describe("overview (default) | db-health | telemetry | insights"),
        },
        async execute(args) {
          return rt.statsTool(args.report);
        },
      }),
    },
    resolvePluginToolSurfaceMaxChars(rt.cfg),
    ),
  };
};

export default wrapPlugin(EngramPlugin, { name: "engram" });

function fleetArgs(correlation: ReturnType<typeof correlationFromUnknown>) {
  if (!correlation) return {};
  return {
    workspace_id: correlation.workspace_id ?? undefined,
    plan_id: correlation.plan_id ?? undefined,
    plan_slug: correlation.plan_slug ?? undefined,
    wave_id: correlation.wave_id ?? undefined,
    agent_run_id: correlation.agent_run_id ?? undefined,
    correlation_id: correlation.correlation_id ?? undefined,
    tool_call_id: correlation.tool_call_id ?? undefined,
    spine_seq: correlation.spine_seq ?? undefined,
    artifact_ref: correlation.artifact_ref ?? undefined,
    lifecycle_object_id: correlation.lifecycle_object_id ?? undefined,
    concord_event_id: correlation.concord_event_id ?? undefined,
  };
}
