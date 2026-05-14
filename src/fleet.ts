import { extractFleetContextFromUnknown } from "@mazac-fox/opencode-host-adapter";
import {
  emptyFleetContext,
  fleetContextToJson,
  mergeFleetContext,
} from "@mazac-fox/opencode-fleet-contracts";
import type { EngramCorrelation } from "./types.ts";

export function correlationFromUnknown(...values: unknown[]): EngramCorrelation | null {
  const decoded = extractFleetContextFromUnknown(...values);
  return Object.values(fleetContextToJson(decoded)).some((value) => value !== null)
    ? decoded
    : null;
}

export function correlationToDetail(
  detail: Record<string, unknown> | null,
  correlation: EngramCorrelation | null | undefined,
): Record<string, unknown> | null {
  if (!correlation) return detail;
  return { ...(detail ?? {}), fleet: fleetContextToJson(correlation) };
}

export function withArtifactCorrelation(
  base: EngramCorrelation | null | undefined,
  artifactRef: string,
  lifecycleObjectId: string | null,
): EngramCorrelation {
  return mergeFleetContext(base ?? emptyFleetContext(), {
    artifact_ref: artifactRef as EngramCorrelation["artifact_ref"],
    lifecycle_object_id: lifecycleObjectId as EngramCorrelation["lifecycle_object_id"],
  });
}
