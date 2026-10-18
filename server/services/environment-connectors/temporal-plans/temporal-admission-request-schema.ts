import { helixEnvironmentActionRequestSchema } from "@shared/helix-environment-action";

/** Caller metadata only. The authenticated MCP boundary supplies participant_id;
 * preflight supplies all executable and canonical compilation content.
 * The complete action schema must still validate the assembled broker request. */
export const temporalAdmissionRequestMetadataSchema = helixEnvironmentActionRequestSchema
  .innerType().omit({
    participant_id: true,
    arguments: true,
    temporal_plan: true,
    temporal_plan_canonical_json: true,
    temporal_compilation_hash: true,
    temporal_compilation_canonical_json: true,
  }).strict();
