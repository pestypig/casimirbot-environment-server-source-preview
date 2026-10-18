import type { HelixEnvironmentReasoningRoleProjection } from
  "@shared/helix-environment-reasoning-role";

export const HELIX_ENVIRONMENT_REASONING_ROLE_AUDIT_SCHEMA =
  "helix.environment_reasoning_role_continuity_audit.v1" as const;

export type EnvironmentReasoningRoleContinuityStage =
  | "role_output"
  | "principal_disposition"
  | "arbitration"
  | "execution_link"
  | "measured_result_reentry";

export type EnvironmentReasoningRoleContinuityAudit = {
  schema: typeof HELIX_ENVIRONMENT_REASONING_ROLE_AUDIT_SCHEMA;
  goal_id: string;
  ledger_revision: number;
  status: "consistent" | "pending" | "divergent";
  first_divergent_stage: EnvironmentReasoningRoleContinuityStage | null;
  reason: string;
  checked_role_output_ids: string[];
  checked_arbitration_ids: string[];
  observer_only: true;
  can_admit: false;
  can_reject: false;
  can_rewrite: false;
  can_execute: false;
  answer_authority: false;
  terminal_eligible: false;
};

export const auditEnvironmentReasoningRoleContinuity = (
  projection: HelixEnvironmentReasoningRoleProjection,
): EnvironmentReasoningRoleContinuityAudit => {
  const outputs = new Map(
    projection.outputs.map((output) => [output.role_output_id, output]),
  );
  const dispositions = new Map(
    projection.principal_dispositions.map((entry) => [entry.role_output_id, entry]),
  );
  const checkedArbitrations: string[] = [];
  const divergent = (
    stage: EnvironmentReasoningRoleContinuityStage,
    reason: string,
  ): EnvironmentReasoningRoleContinuityAudit => ({
    schema: HELIX_ENVIRONMENT_REASONING_ROLE_AUDIT_SCHEMA,
    goal_id: projection.goal_id,
    ledger_revision: projection.revision,
    status: "divergent",
    first_divergent_stage: stage,
    reason,
    checked_role_output_ids: [...outputs.keys()],
    checked_arbitration_ids: checkedArbitrations,
    observer_only: true,
    can_admit: false,
    can_reject: false,
    can_rewrite: false,
    can_execute: false,
    answer_authority: false,
    terminal_eligible: false,
  });

  for (const arbitration of projection.arbitrations) {
    checkedArbitrations.push(arbitration.arbitration_id);
    const selectedId = arbitration.selected_role_output_id;
    if (!selectedId) continue;
    const output = outputs.get(selectedId);
    if (!output) {
      return divergent(
        "role_output",
        "A selected arbitration references an absent role output.",
      );
    }
    const disposition = dispositions.get(selectedId);
    if (
      !disposition ||
      !["adopted", "revised"].includes(disposition.disposition)
    ) {
      return divergent(
        "principal_disposition",
        "A selected arbitration lacks an adopted or revised principal disposition.",
      );
    }
    if (disposition.principal_turn_id !== output.identity.principal_turn_id) {
      return divergent(
        "principal_disposition",
        "The selected output and principal disposition name different turns.",
      );
    }
    if (projection.invalidated_output_ids.includes(selectedId)) {
      return divergent(
        "arbitration",
        "A selected arbitration references an invalidated output.",
      );
    }
    const executionLinks = projection.execution_links.filter(
      (entry) => entry.arbitration_id === arbitration.arbitration_id,
    );
    if (executionLinks.length > 1) {
      return divergent(
        "execution_link",
        "One arbitration has more than one execution link.",
      );
    }
    const execution = executionLinks[0];
    if (!execution) continue;
    if (
      execution.role_output_id !== selectedId ||
      execution.capability_id !== disposition.adopted_capability_id
    ) {
      return divergent(
        "execution_link",
        "The execution link does not match the selected principal-adopted capability.",
      );
    }
    const results = projection.measured_result_links.filter(
      (entry) =>
        entry.environment_action_request_id ===
        execution.environment_action_request_id,
    );
    if (results.length !== 1) {
      return divergent(
        "measured_result_reentry",
        results.length === 0
          ? "An executed G6 proposal lacks measured-result re-entry."
          : "An executed G6 proposal has competing measured-result re-entry links.",
      );
    }
    if (results[0].principal_turn_id !== output.identity.principal_turn_id) {
      return divergent(
        "measured_result_reentry",
        "The measured result re-entered a different principal turn.",
      );
    }
  }

  const hasPending = projection.outputs.some((output) => {
    if (projection.invalidated_output_ids.includes(output.role_output_id)) {
      return false;
    }
    const disposition = dispositions.get(output.role_output_id);
    if (!disposition) return true;
    if (!["adopted", "revised"].includes(disposition.disposition)) return false;
    return !projection.arbitrations.some((entry) =>
      entry.selected_role_output_id === output.role_output_id,
    );
  }) || projection.arbitrations.some((arbitration) => {
    if (!arbitration.selected_role_output_id) return false;
    return !projection.execution_links.some(
      (entry) => entry.arbitration_id === arbitration.arbitration_id,
    );
  });

  return {
    schema: HELIX_ENVIRONMENT_REASONING_ROLE_AUDIT_SCHEMA,
    goal_id: projection.goal_id,
    ledger_revision: projection.revision,
    status: hasPending ? "pending" : "consistent",
    first_divergent_stage: null,
    reason: hasPending
      ? "Canonical G6 work is awaiting principal disposition, arbitration, or execution."
      : "Every completed G6 causal link is structurally continuous.",
    checked_role_output_ids: [...outputs.keys()],
    checked_arbitration_ids: checkedArbitrations,
    observer_only: true,
    can_admit: false,
    can_reject: false,
    can_rewrite: false,
    can_execute: false,
    answer_authority: false,
    terminal_eligible: false,
  };
};
