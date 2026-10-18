import crypto from "node:crypto";
import {
  HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_AUDIT_SCHEMA,
  HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_STAGES,
  helixEnvironmentActionDifferentialAuditSchema,
  helixEnvironmentActionDifferentialTraceSchema,
  type HelixEnvironmentActionDifferentialAudit,
  type HelixEnvironmentActionDifferentialStage,
  type HelixEnvironmentActionDifferentialTrace,
} from "@shared/helix-environment-action";

type Mismatch = HelixEnvironmentActionDifferentialAudit["mismatches"][number];

const value = (input: unknown): string | null => {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") return input;
  if (typeof input === "boolean" || typeof input === "number") {
    return String(input);
  }
  return JSON.stringify(input);
};

const hashIdentity = (input: string): string =>
  crypto.createHash("sha256").update(input, "utf8").digest("hex");

const missingRefs = (required: string[], retained: string[]): string[] => {
  const retainedSet = new Set(retained);
  return required.filter((entry) => !retainedSet.has(entry));
};

/**
 * Observer-only A/B comparison between a public direct-Codex trace and the
 * equivalent Helix lifecycle. It never admits an action, retries it, changes a
 * result, or grants terminal authority.
 */
export const auditEnvironmentActionDifferentialTraces = (input: {
  reference: HelixEnvironmentActionDifferentialTrace;
  helix: HelixEnvironmentActionDifferentialTrace;
  comparedAt?: string;
}): HelixEnvironmentActionDifferentialAudit => {
  const reference = helixEnvironmentActionDifferentialTraceSchema.parse(
    input.reference,
  );
  const helix = helixEnvironmentActionDifferentialTraceSchema.parse(input.helix);
  const mismatches: Mismatch[] = [];
  const add = (
    stage: HelixEnvironmentActionDifferentialStage,
    code: string,
    referenceValue: unknown,
    helixValue: unknown,
  ) => mismatches.push({
    stage,
    code,
    reference_value: value(referenceValue),
    helix_value: value(helixValue),
  });

  if (reference.lane !== "direct_codex" || helix.lane !== "helix") {
    add("fixture_identity", "differential_lane_mismatch", reference.lane, helix.lane);
  }
  for (const [code, left, right] of [
    ["scenario_identity_mismatch", reference.scenario_id, helix.scenario_id],
    ["action_kind_mismatch", reference.action_kind, helix.action_kind],
    ["prompt_hash_mismatch", reference.prompt_hash, helix.prompt_hash],
    ["starting_state_hash_mismatch", reference.starting_state_hash, helix.starting_state_hash],
    ["capability_contract_hash_mismatch", reference.capability_contract_hash, helix.capability_contract_hash],
  ] as const) {
    if (left !== right) add("fixture_identity", code, left, right);
  }

  if (reference.selected_capability_id !== helix.selected_capability_id) {
    add(
      "capability_selection",
      "selected_capability_mismatch",
      reference.selected_capability_id,
      helix.selected_capability_id,
    );
  }
  if (reference.normalized_arguments_hash !== helix.normalized_arguments_hash) {
    add(
      "capability_selection",
      "normalized_arguments_mismatch",
      reference.normalized_arguments_hash,
      helix.normalized_arguments_hash,
    );
  }

  if (
    reference.execution_outcome !== "not_run" &&
    helix.admission_status !== "admitted"
  ) {
    add(
      "tool_admission",
      "reference_action_not_admitted_by_helix",
      reference.execution_outcome,
      helix.admission_status,
    );
  }
  if (reference.execution_outcome !== helix.execution_outcome) {
    add(
      "tool_execution",
      "execution_outcome_mismatch",
      reference.execution_outcome,
      helix.execution_outcome,
    );
  }
  if (
    JSON.stringify(reference.normalized_progress_hashes) !==
      JSON.stringify(helix.normalized_progress_hashes)
  ) {
    add(
      "workflow_progress",
      "normalized_progress_mismatch",
      reference.normalized_progress_hashes,
      helix.normalized_progress_hashes,
    );
  }
  if (reference.postcondition_status !== helix.postcondition_status) {
    add(
      "postcondition_verification",
      "postcondition_status_mismatch",
      reference.postcondition_status,
      helix.postcondition_status,
    );
  }
  if (
    reference.execution_outcome !== "not_run" &&
    reference.observation_refs.length === 0
  ) {
    add(
      "evidence_reentry",
      "reference_execution_observation_refs_missing",
      "one_or_more_observation_refs",
      reference.observation_refs,
    );
  }
  if (
    helix.execution_outcome !== "not_run" &&
    helix.observation_refs.length === 0
  ) {
    add(
      "evidence_reentry",
      "helix_execution_observation_refs_missing",
      "one_or_more_observation_refs",
      helix.observation_refs,
    );
  }
  if (reference.observation_reentered && !helix.observation_reentered) {
    add(
      "evidence_reentry",
      "reference_observation_not_reentered_by_helix",
      true,
      false,
    );
  }
  if (helix.execution_outcome !== "not_run" && !helix.observation_reentered) {
    add(
      "evidence_reentry",
      "executed_action_observation_not_reentered_by_helix",
      helix.execution_outcome,
      false,
    );
  }
  if (reference.final_candidate_hash && !helix.final_candidate_hash) {
    add(
      "final_candidate",
      "post_observation_candidate_missing",
      reference.final_candidate_hash,
      null,
    );
  }
  if (helix.observation_reentered && !helix.final_candidate_hash) {
    add(
      "final_candidate",
      "reentered_observation_candidate_missing",
      helix.observation_refs,
      null,
    );
  }
  const candidateMissingObservationRefs = missingRefs(
    helix.observation_refs,
    helix.final_candidate_support_refs,
  );
  if (helix.final_candidate_hash && candidateMissingObservationRefs.length > 0) {
    add(
      "final_candidate",
      "final_candidate_dropped_observation_support",
      helix.observation_refs,
      candidateMissingObservationRefs,
    );
  }
  if (helix.final_candidate_hash && !helix.route_product_hash) {
    add(
      "route_product_materialization",
      "provider_route_product_missing",
      helix.final_candidate_hash,
      null,
    );
  } else if (
    helix.final_candidate_hash &&
    helix.route_product_hash &&
    helix.final_candidate_hash !== helix.route_product_hash
  ) {
    add(
      "route_product_materialization",
      "final_candidate_route_product_text_mismatch",
      helix.final_candidate_hash,
      helix.route_product_hash,
    );
  }
  const routeProductMissingSupportRefs = missingRefs(
    helix.final_candidate_support_refs,
    helix.route_product_support_refs,
  );
  if (helix.route_product_hash && routeProductMissingSupportRefs.length > 0) {
    add(
      "route_product_materialization",
      "provider_route_product_dropped_candidate_support",
      helix.final_candidate_support_refs,
      routeProductMissingSupportRefs,
    );
  }
  if (reference.terminal_outcome !== helix.terminal_outcome) {
    add(
      "terminal_authority",
      "terminal_outcome_mismatch",
      reference.terminal_outcome,
      helix.terminal_outcome,
    );
  }
  const authorityAcceptable = reference.terminal_outcome === "success"
    ? helix.terminal_authority_status === "passed"
    : ["passed", "failed_closed", "not_applicable"].includes(
        helix.terminal_authority_status,
      );
  if (!authorityAcceptable) {
    add(
      "terminal_authority",
      "helix_terminal_authority_incomplete",
      reference.terminal_outcome,
      helix.terminal_authority_status,
    );
  }
  if (
    helix.route_product_hash &&
    helix.terminal_writer_hash &&
    helix.route_product_hash !== helix.terminal_writer_hash
  ) {
    add(
      "terminal_authority",
      "route_product_terminal_writer_text_mismatch",
      helix.route_product_hash,
      helix.terminal_writer_hash,
    );
  }
  const terminalWriterMissingSupportRefs = missingRefs(
    helix.route_product_support_refs,
    helix.terminal_writer_support_refs,
  );
  if (helix.terminal_writer_hash && terminalWriterMissingSupportRefs.length > 0) {
    add(
      "terminal_authority",
      "terminal_writer_dropped_route_product_support",
      helix.route_product_support_refs,
      terminalWriterMissingSupportRefs,
    );
  }
  if (
    !["unknown", "not_applicable"].includes(helix.terminal_outcome) &&
    (!helix.terminal_writer_hash || !helix.visible_text_hash)
  ) {
    add(
      "presentation",
      "visible_terminal_projection_missing",
      "writer_and_visible_hash_required",
      `${helix.terminal_writer_hash ?? "null"}:${helix.visible_text_hash ?? "null"}`,
    );
  } else if (
    helix.terminal_writer_hash &&
    helix.visible_text_hash &&
    helix.terminal_writer_hash !== helix.visible_text_hash
  ) {
    add(
      "presentation",
      "terminal_writer_visible_text_mismatch",
      helix.terminal_writer_hash,
      helix.visible_text_hash,
    );
  }
  if (
    helix.voice_projection_status === "consistent" &&
    (!helix.visible_text_hash ||
      !helix.voice_text_hash ||
      helix.visible_text_hash !== helix.voice_text_hash)
  ) {
    add(
      "presentation",
      "text_voice_terminal_divergence",
      helix.visible_text_hash,
      helix.voice_text_hash,
    );
  } else if (helix.voice_projection_status === "inconsistent") {
    add(
      "presentation",
      "text_voice_terminal_divergence",
      helix.visible_text_hash,
      helix.voice_text_hash,
    );
  }

  const firstDivergenceStage = HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_STAGES.find(
    (stage) => mismatches.some((entry) => entry.stage === stage),
  ) ?? null;
  return helixEnvironmentActionDifferentialAuditSchema.parse({
    schema: HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_AUDIT_SCHEMA,
    audit_id: `environment_action_differential_audit:${hashIdentity(
      `${reference.trace_id}\n${helix.trace_id}`,
    ).slice(0, 40)}`,
    scenario_id: reference.scenario_id,
    action_kind: reference.action_kind,
    ok: mismatches.length === 0,
    first_divergence_stage: firstDivergenceStage,
    mismatches,
    reference_trace_ref: reference.trace_id,
    helix_trace_ref: helix.trace_id,
    compared_at: input.comparedAt ?? new Date().toISOString(),
    observer_only: true,
    hidden_reasoning_included: false,
    content_role: "environment_action_differential_audit_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });
};
