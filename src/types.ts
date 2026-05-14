import type { FleetContext } from "@mazac-fox/opencode-fleet-contracts";

export type ChunkInsert = {
  id: string;
  session_id: string;
  message_id: string;
  part_id: string | null;
  project_id: string;
  role: "assistant" | "user";
  agent: string | null;
  model: string | null;
  content_type: string;
  content: string;
  file_paths: string | null;
  tool_name: string | null;
  tool_status: string | null;
  output_head: string | null;
  output_tail: string | null;
  output_length: number | null;
  error_class: string | null;
  time_created: number;
  content_hash: string;
  root_session_id: string | null;
  session_depth: number | null;
  plan_slug: string | null;
  correlation?: EngramCorrelation | null;
};

export type EngramCorrelation = Pick<
  FleetContext,
  | "workspace_id"
  | "plan_id"
  | "plan_slug"
  | "wave_id"
  | "agent_run_id"
  | "correlation_id"
  | "tool_call_id"
  | "spine_seq"
  | "artifact_ref"
  | "lifecycle_object_id"
  | "concord_event_id"
  | "fleet_run_id"
>;

export type ChunkCorrelationRow = {
  chunk_id: string;
  workspace_id: string | null;
  plan_id: string | null;
  wave_id: string | null;
  agent_run_id: string | null;
  correlation_id: string | null;
  tool_call_id: string | null;
  spine_seq: number | null;
  artifact_ref: string | null;
  lifecycle_object_id: string | null;
};

export type ChunkCorrelationFilters = Partial<ChunkCorrelationRow>;
