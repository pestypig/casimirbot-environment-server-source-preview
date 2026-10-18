import crypto from "node:crypto";
import {
  HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_STAGES,
  HELIX_ENVIRONMENT_ACTION_G2_PARITY_AUDIT_SCHEMA,
  helixEnvironmentActionDifferentialTraceSchema,
  helixEnvironmentActionG2ParityAuditSchema,
  type HelixEnvironmentActionDifferentialStage,
  type HelixEnvironmentActionDifferentialTrace,
  type HelixEnvironmentActionG2ParityAudit,
} from "@shared/helix-environment-action";

type Comparison = "a0_to_a1" | "a1_to_b";
type Mismatch = HelixEnvironmentActionG2ParityAudit["mismatches"][number];

const render = (input: unknown): string | null => {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") return input;
  if (typeof input === "boolean" || typeof input === "number") return String(input);
  return JSON.stringify(input);
};

const hashIdentity = (input: string): string =>
  crypto.createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Observer-only G2 comparison across A0 direct Fabric, A1 Codex through MCP,
 * and B Helix Ask. It reports continuity; it cannot admit, execute, retry,
 * reconcile, materialize, or grant terminal authority.
 *
 * Observation identifiers are intentionally lane-local. The audit proves that
 * each executed lane returned evidence and retained its own support refs; it
 * does not require unrelated executions to manufacture identical identifiers.
 */
export const auditEnvironmentActionG2Parity = (input: {
  a0: HelixEnvironmentActionDifferentialTrace;
  a1: HelixEnvironmentActionDifferentialTrace;
  b: HelixEnvironmentActionDifferentialTrace;
  comparedAt?: string;
}): HelixEnvironmentActionG2ParityAudit => {
  const a0 = helixEnvironmentActionDifferentialTraceSchema.parse(input.a0);
  const a1 = helixEnvironmentActionDifferentialTraceSchema.parse(input.a1);
  const b = helixEnvironmentActionDifferentialTraceSchema.parse(input.b);
  const mismatches: Mismatch[] = [];
  const add = (
    comparison: Comparison,
    stage: HelixEnvironmentActionDifferentialStage,
    code: string,
    expected: unknown,
    observed: unknown,
  ) => mismatches.push({
    comparison,
    stage,
    code,
    expected_value: render(expected),
    observed_value: render(observed),
  });

  if (a0.lane !== "direct_codex") {
    add("a0_to_a1", "fixture_identity", "a0_lane_mismatch", "direct_codex", a0.lane);
  }
  if (a1.lane !== "codex_mcp") {
    add("a0_to_a1", "fixture_identity", "a1_lane_mismatch", "codex_mcp", a1.lane);
  }
  if (b.lane !== "helix_ask") {
    add("a1_to_b", "fixture_identity", "b_lane_mismatch", "helix_ask", b.lane);
  }

  const compareFixture = (
    comparison: Comparison,
    left: HelixEnvironmentActionDifferentialTrace,
    right: HelixEnvironmentActionDifferentialTrace,
  ) => {
    for (const [code, expected, observed] of [
      ["scenario_identity_mismatch", left.scenario_id, right.scenario_id],
      ["action_kind_mismatch", left.action_kind, right.action_kind],
      ["prompt_hash_mismatch", left.prompt_hash, right.prompt_hash],
      ["starting_state_hash_mismatch", left.starting_state_hash, right.starting_state_hash],
      ["capability_contract_hash_mismatch", left.capability_contract_hash, right.capability_contract_hash],
    ] as const) {
      if (expected !== observed) {
        add(comparison, "fixture_identity", code, expected, observed);
      }
    }
  };
  compareFixture("a0_to_a1", a0, a1);
  compareFixture("a1_to_b", a1, b);

  const compareExecution = (
    comparison: Comparison,
    left: HelixEnvironmentActionDifferentialTrace,
    right: HelixEnvironmentActionDifferentialTrace,
    rightName: "a1" | "b",
  ) => {
    if (left.selected_capability_id !== right.selected_capability_id) {
      add(comparison, "capability_selection", "selected_capability_mismatch", left.selected_capability_id, right.selected_capability_id);
    }
    if (left.normalized_arguments_hash !== right.normalized_arguments_hash) {
      add(comparison, "capability_selection", "normalized_arguments_mismatch", left.normalized_arguments_hash, right.normalized_arguments_hash);
    }
    if (left.execution_outcome !== "not_run" && right.admission_status !== "admitted") {
      add(comparison, "tool_admission", `${rightName}_action_not_admitted`, "admitted", right.admission_status);
    }
    if (left.execution_outcome !== right.execution_outcome) {
      add(comparison, "tool_execution", "execution_outcome_mismatch", left.execution_outcome, right.execution_outcome);
    }
    if (JSON.stringify(left.normalized_progress_hashes) !== JSON.stringify(right.normalized_progress_hashes)) {
      add(comparison, "workflow_progress", "normalized_progress_mismatch", left.normalized_progress_hashes, right.normalized_progress_hashes);
    }
    if (left.postcondition_status !== right.postcondition_status) {
      add(comparison, "postcondition_verification", "postcondition_status_mismatch", left.postcondition_status, right.postcondition_status);
    }
  };
  compareExecution("a0_to_a1", a0, a1, "a1");
  compareExecution("a1_to_b", a1, b, "b");

  const requireReentry = (
    comparison: Comparison,
    trace: HelixEnvironmentActionDifferentialTrace,
    laneName: "a0" | "a1" | "b",
  ) => {
    if (trace.execution_outcome !== "not_run" && trace.observation_refs.length === 0) {
      add(comparison, "evidence_reentry", `${laneName}_execution_observation_refs_missing`, "one_or_more_observation_refs", trace.observation_refs);
    }
    if (trace.execution_outcome !== "not_run" && !trace.observation_reentered) {
      add(comparison, "evidence_reentry", `${laneName}_execution_observation_not_reentered`, true, false);
    }
    if (trace.observation_reentered && !trace.final_candidate_hash) {
      add(comparison, "final_candidate", `${laneName}_post_observation_candidate_missing`, "public_candidate_hash", null);
    }
    const support = new Set(trace.final_candidate_support_refs);
    const missing = trace.observation_refs.filter((ref) => !support.has(ref));
    if (trace.final_candidate_hash && missing.length > 0) {
      add(comparison, "final_candidate", `${laneName}_candidate_dropped_observation_support`, trace.observation_refs, missing);
    }
  };
  if (a0.execution_outcome !== "not_run" && a0.observation_refs.length === 0) {
    add("a0_to_a1", "tool_execution", "a0_terminal_controller_evidence_missing", "one_or_more_public_controller_refs", a0.observation_refs);
  }
  requireReentry("a0_to_a1", a1, "a1");
  requireReentry("a1_to_b", b, "b");

  if (a1.route_product_hash || a1.terminal_writer_hash || a1.visible_text_hash || a1.terminal_authority_status !== "not_applicable") {
    add("a0_to_a1", "terminal_authority", "a1_mcp_claimed_ask_terminal_authority", "nonterminal_mcp_observation", {
      route_product_hash: a1.route_product_hash,
      terminal_writer_hash: a1.terminal_writer_hash,
      visible_text_hash: a1.visible_text_hash,
      terminal_authority_status: a1.terminal_authority_status,
    });
  }

  if (b.final_candidate_hash && !b.route_product_hash) {
    add("a1_to_b", "route_product_materialization", "b_route_product_missing", b.final_candidate_hash, null);
  } else if (b.final_candidate_hash && b.route_product_hash !== b.final_candidate_hash) {
    add("a1_to_b", "route_product_materialization", "b_candidate_route_product_text_mismatch", b.final_candidate_hash, b.route_product_hash);
  }
  const routeSupport = new Set(b.route_product_support_refs);
  const missingRouteSupport = b.final_candidate_support_refs.filter((ref) => !routeSupport.has(ref));
  if (b.route_product_hash && missingRouteSupport.length > 0) {
    add("a1_to_b", "route_product_materialization", "b_route_product_dropped_candidate_support", b.final_candidate_support_refs, missingRouteSupport);
  }
  const authorityAcceptable = b.terminal_outcome === "success"
    ? b.terminal_authority_status === "passed"
    : ["passed", "failed_closed"].includes(b.terminal_authority_status);
  if (!authorityAcceptable) {
    add("a1_to_b", "terminal_authority", "b_terminal_authority_incomplete", b.terminal_outcome, b.terminal_authority_status);
  }
  if (b.route_product_hash && b.terminal_writer_hash !== b.route_product_hash) {
    add("a1_to_b", "terminal_authority", "b_route_product_terminal_writer_text_mismatch", b.route_product_hash, b.terminal_writer_hash);
  }
  const writerSupport = new Set(b.terminal_writer_support_refs);
  const missingWriterSupport = b.route_product_support_refs.filter((ref) => !writerSupport.has(ref));
  if (b.terminal_writer_hash && missingWriterSupport.length > 0) {
    add("a1_to_b", "terminal_authority", "b_terminal_writer_dropped_route_product_support", b.route_product_support_refs, missingWriterSupport);
  }
  if (!b.terminal_writer_hash || !b.visible_text_hash) {
    add("a1_to_b", "presentation", "b_visible_terminal_projection_missing", "writer_and_visible_hash_required", `${b.terminal_writer_hash ?? "null"}:${b.visible_text_hash ?? "null"}`);
  } else if (b.terminal_writer_hash !== b.visible_text_hash) {
    add("a1_to_b", "presentation", "b_terminal_writer_visible_text_mismatch", b.terminal_writer_hash, b.visible_text_hash);
  }
  if (b.voice_projection_status === "inconsistent" ||
      (b.voice_projection_status === "consistent" && b.voice_text_hash !== b.visible_text_hash)) {
    add("a1_to_b", "presentation", "b_text_voice_terminal_divergence", b.visible_text_hash, b.voice_text_hash);
  }

  const firstDivergenceStage = HELIX_ENVIRONMENT_ACTION_DIFFERENTIAL_STAGES.find(
    (stage) => mismatches.some((entry) => entry.stage === stage),
  ) ?? null;
  return helixEnvironmentActionG2ParityAuditSchema.parse({
    schema: HELIX_ENVIRONMENT_ACTION_G2_PARITY_AUDIT_SCHEMA,
    audit_id: `environment_action_g2_parity_audit:${hashIdentity(`${a0.trace_id}\n${a1.trace_id}\n${b.trace_id}`).slice(0, 40)}`,
    scenario_id: a0.scenario_id,
    action_kind: a0.action_kind,
    ok: mismatches.length === 0,
    first_divergence_stage: firstDivergenceStage,
    mismatches,
    a0_trace_ref: a0.trace_id,
    a1_trace_ref: a1.trace_id,
    b_trace_ref: b.trace_id,
    compared_at: input.comparedAt ?? new Date().toISOString(),
    observer_only: true,
    hidden_reasoning_included: false,
    content_role: "environment_action_g2_parity_audit_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });
};
