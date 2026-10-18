/** Closed diagnostic vocabulary: never project arbitrary exception messages. */
export type TemporalPlanErrorCode =
  | "temporal_direct_context_identity_mismatch"
  | "temporal_direct_context_unavailable"
  | "temporal_checkpoint_action_event_hash_mismatch"
  | "temporal_checkpoint_action_event_mismatch"
  | "temporal_checkpoint_action_mismatch"
  | "temporal_checkpoint_anchor_clock_invalid"
  | "temporal_checkpoint_anchor_hash_mismatch"
  | "temporal_checkpoint_anchor_identity_mismatch"
  | "temporal_checkpoint_anchor_settlement_changed"
  | "temporal_checkpoint_anchor_state_invalid"
  | "temporal_checkpoint_clock_unmapped"
  | "temporal_checkpoint_event_hash_mismatch"
  | "temporal_checkpoint_event_identity_or_state_mismatch"
  | "temporal_checkpoint_event_stale"
  | "temporal_checkpoint_native_plan_mismatch"
  | "temporal_checkpoint_reference_unverified"
  | "temporal_checkpoint_resident_association_mismatch"
  | "temporal_retention_action_already_dispatched"
  | "temporal_retention_action_mismatch"
  | "temporal_retention_binding_invalid"
  | "temporal_retention_checkpoint_replay_conflict"
  | "temporal_retention_checkpoint_required"
  | "temporal_retention_committed_window_overlap"
  | "temporal_retention_compilation_mismatch"
  | "temporal_retention_frontier_predates_checkpoint"
  | "temporal_retention_frontier_stale"
  | "temporal_retention_goal_forbidden"
  | "temporal_retention_goal_stale"
  | "temporal_retention_predecessor_binding_mismatch"
  | "temporal_retention_predecessor_clock_mismatch"
  | "temporal_retention_predecessor_hash_mismatch"
  | "temporal_retention_predecessor_identity_mismatch"
  | "temporal_retention_predecessor_revision_regressed"
  | "temporal_retention_replay_conflict"
  | "temporal_retention_responses_checkpoint_hash_mismatch"
  | "temporal_retention_responses_snapshot_invalid"
  | "temporal_retention_responses_snapshot_mismatch"
  | "temporal_retention_resident_unresolved"
  | "temporal_retention_successor_already_admitted"
  | "temporal_retention_task_mismatch"
  | "temporal_frontier_time_invalid"
  | "temporal_frontier_forbidden"
  | "temporal_frontier_integrity_invalid"
  | "temporal_frontier_goal_stale"
  | "temporal_frontier_retention_invalid"
  | "temporal_frontier_replay_conflict"
  | "temporal_frontier_revision_overflow"
  | "temporal_frontier_observation_regressed"
  | "temporal_frontier_observation_clock_invalid"
  | "temporal_frontier_resident_clock_unmapped"
  | "temporal_frontier_resident_clock_expired"
  | "temporal_plan_task_context_mismatch"
  | "temporal_plan_frontier_unavailable"
  | "temporal_plan_frontier_identity_mismatch"
  | "temporal_plan_executor_unavailable"
  | "temporal_plan_affordance_unavailable"
  | "temporal_plan_resident_clock_mismatch"
  | "temporal_plan_late_binding_clock_invalid"
  | "temporal_plan_fresh_probe_unavailable"
  | "temporal_plan_not_current"
  | "temporal_plan_frontier_expired_or_unmapped"
  | "temporal_admission_request_context_mismatch";

export class TemporalPlanError extends Error {
  constructor(readonly code: TemporalPlanErrorCode) {
    super(code);
    this.name = "TemporalPlanError";
  }
}

export const temporalPlanErrorProjection = (error: unknown) =>
  error instanceof TemporalPlanError ? {
    schema: "helix.environment_temporal_plan_error.v1" as const,
    error: error.code,
    message: "Temporal admission was rejected; revalidate the named prerequisite before proposing fresh work.",
    retryable: false as const,
    credential_included: false as const,
    raw_content_included: false as const,
    reentry_required: true as const,
    execution_authority: false as const,
    answer_authority: false as const,
    assistant_answer: false as const,
    terminal_eligible: false as const,
  } : null;
