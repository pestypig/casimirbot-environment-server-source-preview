import crypto from "node:crypto";
import { z } from "zod";
import {
  HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_TRACE_SCHEMA,
  helixEnvironmentActionDifferentialTraceSchema,
  helixEnvironmentActionOutcomeSchema,
  type HelixEnvironmentActionDifferentialTrace,
} from "@shared/helix-environment-action";
import { environmentConnectorSha256 } from "../catalog";

const identifier = z.string().trim().min(1).max(512);
const boundedText = z.string().max(200_000);

/**
 * Public, operator-produced capture input. It deliberately excludes provider
 * payloads, hidden reasoning and credentials. The builder only hashes and
 * normalizes supplied lifecycle facts; it cannot admit or execute an action,
 * retry a workflow, write terminal prose or grant terminal authority.
 */
export const environmentActionDifferentialCaptureInputSchema = z
  .object({
    scenario_id: identifier,
    lane: z.enum(["direct_codex", "codex_mcp", "helix_ask", "helix"]),
    action_kind: identifier,
    prompt: boundedText,
    starting_state: z.unknown(),
    capability_contract: z.unknown(),
    source_artifact_refs: z.array(identifier).min(1).max(128),
    selected_capability_id: identifier.nullable(),
    normalized_arguments: z.unknown().nullable(),
    admission_status: z.enum([
      "admitted",
      "rejected",
      "not_observed",
      "not_applicable",
    ]),
    execution_outcome: z.union([
      helixEnvironmentActionOutcomeSchema,
      z.literal("not_run"),
    ]),
    normalized_progress: z.array(z.unknown()).max(1_024),
    postcondition_status: z.enum([
      "satisfied",
      "not_satisfied",
      "unknown",
      "not_checked",
      "not_applicable",
    ]),
    observation_refs: z.array(identifier).max(128),
    observation_reentered: z.boolean(),
    final_candidate_text: boundedText.nullable(),
    final_candidate_support_refs: z.array(identifier).max(128),
    route_product_text: boundedText.nullable(),
    route_product_support_refs: z.array(identifier).max(128),
    terminal_outcome: z.enum([
      "success",
      "typed_failure",
      "blocked",
      "unknown",
      "not_applicable",
    ]),
    terminal_authority_status: z.enum([
      "passed",
      "failed_closed",
      "failed",
      "not_observed",
      "not_applicable",
    ]),
    terminal_writer_text: boundedText.nullable(),
    terminal_writer_support_refs: z.array(identifier).max(128),
    visible_text: boundedText.nullable(),
    voice_projection_status: z.enum([
      "consistent",
      "inconsistent",
      "not_observed",
      "not_applicable",
    ]),
    voice_text: boundedText.nullable(),
    created_at: z.string().datetime(),
    hidden_reasoning_included: z.literal(false),
  })
  .strict();

export type EnvironmentActionDifferentialCaptureInput = z.infer<
  typeof environmentActionDifferentialCaptureInputSchema
>;

const publicTextHash = (value: string | null): `sha256:${string}` | null => {
  if (value === null) return null;
  return `sha256:${crypto
    .createHash("sha256")
    .update(value.trim(), "utf8")
    .digest("hex")}`;
};

const uniqueRefs = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const volatileProgressFields = new Set([
  "clock_id",
  "completed_at",
  "created_at",
  "duration_ticks",
  "observed_at",
  "scheduler_ticks_elapsed",
  "started_at",
  "tick_index",
  "wall_clock_elapsed_ms",
  "world_tick_index",
]);

/**
 * Live executions retain exact clocks in their public source captures, while
 * parity compares the causal workflow: ordered events, node/checkpoint
 * outcomes, mutations, postconditions, and control release. Two executions of
 * the same admitted program are not contradictory merely because physics or
 * scheduler observation completed on different ticks.
 */
const normalizeProgressForParity = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeProgressForParity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !volatileProgressFields.has(key))
      .map(([key, child]) => [key, normalizeProgressForParity(child)]),
  );
};

export const captureEnvironmentActionDifferentialTrace = (
  rawInput: EnvironmentActionDifferentialCaptureInput,
): HelixEnvironmentActionDifferentialTrace => {
  const input = environmentActionDifferentialCaptureInputSchema.parse(rawInput);
  const publicCaptureHash = environmentConnectorSha256(input);

  return helixEnvironmentActionDifferentialTraceSchema.parse({
    schema: HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_TRACE_SCHEMA,
    trace_id: `environment_action_differential_trace:${input.lane}:${publicCaptureHash.slice("sha256:".length, "sha256:".length + 40)}`,
    scenario_id: input.scenario_id,
    lane: input.lane,
    action_kind: input.action_kind,
    prompt_hash: environmentConnectorSha256(input.prompt.trim()),
    starting_state_hash: environmentConnectorSha256(input.starting_state),
    capability_contract_hash: environmentConnectorSha256(
      input.capability_contract,
    ),
    source_artifact_refs: uniqueRefs(input.source_artifact_refs),
    public_capture_hash: publicCaptureHash,
    selected_capability_id: input.selected_capability_id,
    normalized_arguments_hash:
      input.normalized_arguments === null
        ? null
        : environmentConnectorSha256(input.normalized_arguments),
    admission_status: input.admission_status,
    execution_outcome: input.execution_outcome,
    normalized_progress_hashes: input.normalized_progress.map((entry) =>
      environmentConnectorSha256(normalizeProgressForParity(entry)),
    ),
    postcondition_status: input.postcondition_status,
    observation_refs: uniqueRefs(input.observation_refs),
    observation_reentered: input.observation_reentered,
    final_candidate_hash: publicTextHash(input.final_candidate_text),
    final_candidate_support_refs: uniqueRefs(
      input.final_candidate_support_refs,
    ),
    route_product_hash: publicTextHash(input.route_product_text),
    route_product_support_refs: uniqueRefs(input.route_product_support_refs),
    terminal_outcome: input.terminal_outcome,
    terminal_authority_status: input.terminal_authority_status,
    terminal_writer_hash: publicTextHash(input.terminal_writer_text),
    terminal_writer_support_refs: uniqueRefs(
      input.terminal_writer_support_refs,
    ),
    visible_text_hash: publicTextHash(input.visible_text),
    voice_projection_status: input.voice_projection_status,
    voice_text_hash: publicTextHash(input.voice_text),
    created_at: input.created_at,
    hidden_reasoning_included: false,
    content_role: "environment_action_differential_trace_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });
};
